#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod pitch;
mod songs;

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use crossbeam_channel::{bounded, Receiver, Sender};
use pitch::{PitchData, PitchDetector};
use serde::{Deserialize, Serialize};
use songs::{recommend_songs_internal, SongRecommendation};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Command;
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;
use tauri_plugin_dialog::DialogExt;

#[derive(Serialize)]
struct InputDeviceInfo {
    id: String,
    name: String,
    default_sample_rate: Option<u32>,
    channels: Option<u16>,
}

struct StreamState {
    stream: Option<cpal::Stream>,
    analyzer_handle: Option<JoinHandle<()>>,
    analyzer_stop_tx: Option<Sender<()>>,
    level_bits: Arc<AtomicU32>,
    pitch_data: Arc<Mutex<PitchData>>,
    current_device: Option<String>,
}

#[derive(Default, Serialize, Deserialize)]
struct ImportAnalyzeResponse {
    added: i32,
    failed: Vec<String>,
    logs: Vec<String>,
    output: Option<String>,
}

impl Default for StreamState {
    fn default() -> Self {
        Self {
            stream: None,
            analyzer_handle: None,
            analyzer_stop_tx: None,
            level_bits: Arc::new(AtomicU32::new(0.0f32.to_bits())),
            pitch_data: Arc::new(Mutex::new(PitchData::default())),
            current_device: None,
        }
    }
}

fn device_to_info(id: String, device: &cpal::Device) -> InputDeviceInfo {
    let name = device.name().unwrap_or_else(|_| "Unknown Input Device".to_string());
    let default_config = device.default_input_config().ok();

    InputDeviceInfo {
        id,
        name,
        default_sample_rate: default_config.as_ref().map(|cfg| cfg.sample_rate().0),
        channels: default_config.as_ref().map(|cfg| cfg.channels()),
    }
}

fn interleaved_to_mono(chunk: &[f32], channels: usize) -> Vec<f32> {
    if channels <= 1 {
        return chunk.to_vec();
    }

    let mut mono = Vec::with_capacity(chunk.len() / channels + 1);
    for frame in chunk.chunks(channels) {
        let sum: f32 = frame.iter().copied().sum();
        mono.push(sum / channels as f32);
    }
    mono
}

fn spawn_analyzer(
    sample_rx: Receiver<Vec<f32>>,
    stop_rx: Receiver<()>,
    level_bits: Arc<AtomicU32>,
    pitch_data: Arc<Mutex<PitchData>>,
    samples_per_window: usize,
    sample_rate: u32,
    channels: usize,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut ring = VecDeque::<f32>::new();
        let max_ring = samples_per_window.saturating_mul(20).max(samples_per_window);

        let mut pitch_detector = PitchDetector::new(sample_rate, 2048, 512);
        let mut pitch_ring = VecDeque::<f32>::new();
        let max_pitch_ring = pitch_detector.frame_size() * 8;

        loop {
            if stop_rx.try_recv().is_ok() {
                break;
            }

            match sample_rx.recv_timeout(Duration::from_millis(50)) {
                Ok(chunk) => {
                    if !chunk.is_empty() {
                        ring.extend(&chunk);
                        while ring.len() > max_ring {
                            let _ = ring.pop_front();
                        }

                        let mono = interleaved_to_mono(&chunk, channels);
                        pitch_ring.extend(mono);
                    }

                    let mut drained = 0usize;
                    while drained < 8 {
                        let Ok(more) = sample_rx.try_recv() else {
                            break;
                        };
                        if !more.is_empty() {
                            ring.extend(&more);
                            while ring.len() > max_ring {
                                let _ = ring.pop_front();
                            }

                            let mono = interleaved_to_mono(&more, channels);
                            pitch_ring.extend(mono);
                        }
                        drained += 1;
                    }
                }
                Err(crossbeam_channel::RecvTimeoutError::Timeout) => {}
                Err(crossbeam_channel::RecvTimeoutError::Disconnected) => break,
            }

            while pitch_ring.len() > max_pitch_ring {
                let _ = pitch_ring.pop_front();
            }

            let n = samples_per_window.min(ring.len());
            let rms = if n == 0 {
                0.0
            } else {
                let sum_sq: f32 = ring.iter().rev().take(n).map(|s| s * s).sum();
                (sum_sq / n as f32).sqrt().clamp(0.0, 1.0)
            };
            level_bits.store(rms.to_bits(), Ordering::Relaxed);

            let mut latest_pitch: Option<PitchData> = None;
            let mut processed_pitch_frames = 0usize;
            while pitch_ring.len() >= pitch_detector.frame_size() && processed_pitch_frames < 3 {
                let frame: Vec<f32> = pitch_ring
                    .iter()
                    .take(pitch_detector.frame_size())
                    .copied()
                    .collect();
                latest_pitch = Some(pitch_detector.detect(&frame));

                let hop = pitch_detector.hop_size().min(pitch_ring.len());
                for _ in 0..hop {
                    let _ = pitch_ring.pop_front();
                }
                processed_pitch_frames += 1;
            }

            if let Some(pitch) = latest_pitch {
                if pitch.frequency_hz.is_some() || pitch.confidence > 0.0 {
                    match pitch_data.lock() {
                        Ok(mut shared) => *shared = pitch,
                        Err(e) => eprintln!("pitch_data mutex poisoned: {e}"),
                    }
                }
            }
        }

        level_bits.store(0.0f32.to_bits(), Ordering::Relaxed);
        match pitch_data.lock() {
            Ok(mut shared) => *shared = PitchData::default(),
            Err(e) => eprintln!("pitch_data mutex poisoned on cleanup: {e}"),
        }
    })
}

fn resolve_input_device(device_id: Option<&str>) -> Result<(String, cpal::Device), String> {
    let host = cpal::default_host();

    if device_id.is_none() || device_id == Some("default") {
        let device = host
            .default_input_device()
            .ok_or_else(|| "No default input device found".to_string())?;
        return Ok(("default".to_string(), device));
    }

    let wanted = device_id.unwrap_or_default();
    let idx_text = wanted
        .strip_prefix("input-")
        .ok_or_else(|| "Invalid device_id format".to_string())?;
    let target_index: usize = idx_text
        .parse()
        .map_err(|_| "Invalid device_id index".to_string())?;

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to enumerate input devices: {e}"))?;

    for (index, device) in devices.enumerate() {
        if index == target_index {
            return Ok((wanted.to_string(), device));
        }
    }

    Err("Requested input device not found".to_string())
}

#[tauri::command]
fn list_input_devices() -> Result<Vec<InputDeviceInfo>, String> {
    let host = cpal::default_host();
    let default_device_name = host
        .default_input_device()
        .and_then(|device| device.name().ok());

    let devices = host
        .input_devices()
        .map_err(|e| format!("Failed to list input devices: {e}"))?;

    let mut results = Vec::new();

    for (index, device) in devices.enumerate() {
        results.push(device_to_info(format!("input-{index}"), &device));
    }

    if let Some(default_name) = default_device_name {
        let has_default = results.iter().any(|device| device.name == default_name);
        if !has_default {
            if let Some(default_device) = host.default_input_device() {
                results.insert(0, device_to_info("default".to_string(), &default_device));
            }
        }
    }

    Ok(results)
}

#[tauri::command]
fn start_stream(
    device_id: Option<String>,
    state: tauri::State<'_, Mutex<StreamState>>,
) -> Result<String, String> {
    let requested_id = device_id.as_deref();
    let (resolved_id, device) = resolve_input_device(requested_id)?;

    let mut stream_state = state
        .lock()
        .map_err(|_| "Failed to access stream state".to_string())?;

    if stream_state.stream.is_some() {
        return Ok("Stream already running".to_string());
    }

    let default_config = device
        .default_input_config()
        .map_err(|e| format!("Failed to get default input config: {e}"))?;

    let stream_config: cpal::StreamConfig = default_config.clone().into();
    let channels = stream_config.channels as usize;
    let sample_rate = stream_config.sample_rate.0;
    let samples_per_window = ((sample_rate as usize * channels) / 20).max(1);

    let (sample_tx, sample_rx) = bounded::<Vec<f32>>(256);
    let (stop_tx, stop_rx) = bounded::<()>(1);

    let stream = match default_config.sample_format() {
        cpal::SampleFormat::F32 => {
            let tx = sample_tx.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[f32], _| {
                        let mut chunk = Vec::with_capacity(data.len());
                        chunk.extend_from_slice(data);
                        let _ = tx.try_send(chunk);
                    },
                    |err| eprintln!("input stream error: {err}"),
                    None,
                )
                .map_err(|e| format!("Failed to build f32 input stream: {e}"))?
        }
        cpal::SampleFormat::I16 => {
            let tx = sample_tx.clone();
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[i16], _| {
                        let chunk: Vec<f32> = data
                            .iter()
                            .map(|sample| *sample as f32 / i16::MAX as f32)
                            .collect();
                        let _ = tx.try_send(chunk);
                    },
                    |err| eprintln!("input stream error: {err}"),
                    None,
                )
                .map_err(|e| format!("Failed to build i16 input stream: {e}"))?
        }
        cpal::SampleFormat::U16 => {
            let tx = sample_tx;
            device
                .build_input_stream(
                    &stream_config,
                    move |data: &[u16], _| {
                        let chunk: Vec<f32> = data
                            .iter()
                            .map(|sample| (*sample as f32 / u16::MAX as f32) * 2.0 - 1.0)
                            .collect();
                        let _ = tx.try_send(chunk);
                    },
                    |err| eprintln!("input stream error: {err}"),
                    None,
                )
                .map_err(|e| format!("Failed to build u16 input stream: {e}"))?
        }
        sample_format => {
            return Err(format!("Unsupported sample format: {sample_format:?}"));
        }
    };

    stream
        .play()
        .map_err(|e| format!("Failed to start input stream: {e}"))?;

    match stream_state.pitch_data.lock() {
        Ok(mut shared) => *shared = PitchData::default(),
        Err(e) => eprintln!("pitch_data mutex poisoned on start_stream: {e}"),
    }

    let level_bits = Arc::clone(&stream_state.level_bits);
    let pitch_data = Arc::clone(&stream_state.pitch_data);
    let analyzer_handle = spawn_analyzer(
        sample_rx,
        stop_rx,
        level_bits,
        pitch_data,
        samples_per_window,
        sample_rate,
        channels,
    );

    stream_state.current_device = Some(resolved_id);
    stream_state.analyzer_stop_tx = Some(stop_tx);
    stream_state.analyzer_handle = Some(analyzer_handle);
    stream_state.stream = Some(stream);

    Ok("Stream started".to_string())
}

#[tauri::command]
fn stop_stream(state: tauri::State<'_, Mutex<StreamState>>) -> Result<String, String> {
    let mut stream_state = state
        .lock()
        .map_err(|_| "Failed to access stream state".to_string())?;

    if stream_state.stream.is_none() {
        return Ok("Stream already stopped".to_string());
    }

    if let Some(stop_tx) = stream_state.analyzer_stop_tx.take() {
        let _ = stop_tx.try_send(());
    }

    let _ = stream_state.stream.take();

    if let Some(handle) = stream_state.analyzer_handle.take() {
        if let Err(e) = handle.join() {
            eprintln!("analyzer thread panicked: {e:?}");
        }
    }

    stream_state.current_device = None;
    stream_state
        .level_bits
        .store(0.0f32.to_bits(), Ordering::Relaxed);

    match stream_state.pitch_data.lock() {
        Ok(mut shared) => *shared = PitchData::default(),
        Err(e) => eprintln!("pitch_data mutex poisoned on stop_stream: {e}"),
    }

    Ok("Stream stopped".to_string())
}

#[tauri::command]
fn get_input_level(state: tauri::State<'_, Mutex<StreamState>>) -> Result<f32, String> {
    let stream_state = state
        .lock()
        .map_err(|_| "Failed to access stream state".to_string())?;
    Ok(f32::from_bits(
        stream_state.level_bits.load(Ordering::Relaxed),
    ))
}

#[tauri::command]
fn get_pitch_data(state: tauri::State<'_, Mutex<StreamState>>) -> Result<PitchData, String> {
    let stream_state = state
        .lock()
        .map_err(|_| "Failed to access stream state".to_string())?;
    let shared = stream_state
        .pitch_data
        .lock()
        .map_err(|_| "Failed to access pitch data".to_string())?;
    Ok(shared.clone())
}

#[tauri::command]
fn recommend_songs(
    user_low_midi: i32,
    user_high_midi: i32,
    comfort_low_midi: i32,
    comfort_high_midi: i32,
) -> Result<Vec<SongRecommendation>, String> {
    if user_low_midi > user_high_midi || comfort_low_midi > comfort_high_midi {
        return Err("Invalid range input".to_string());
    }

    Ok(recommend_songs_internal(
        user_low_midi,
        user_high_midi,
        comfort_low_midi,
        comfort_high_midi,
    ))
}

#[tauri::command]
fn recommend_imported_songs() -> Result<Vec<SongRecommendation>, String> {
    let mut recs = recommend_songs_internal(45, 69, 48, 64);
    recs.retain(|s| s.is_imported);
    Ok(recs)
}

fn run_analyzer_with(
    python_cmd: &str,
    python_args: &[&str],
    script_path: &PathBuf,
    file_paths: &[String],
) -> Result<ImportAnalyzeResponse, String> {
    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Failed to resolve project root".to_string())?;

    let mut cmd = Command::new(python_cmd);
    let output = cmd
        .args(python_args)
        .arg(script_path)
        .args(file_paths)
        .current_dir(&project_root)
        .output()
        .map_err(|e| format!("Failed to run analyzer with {python_cmd} {:?}: {e}", python_args))?;

    let stdout = String::from_utf8_lossy(&output.stdout);
    let stderr = String::from_utf8_lossy(&output.stderr);

    let mut parsed: Option<ImportAnalyzeResponse> = None;
    for line in stdout.lines() {
        if let Some(json_text) = line.strip_prefix("RESULT_JSON:") {
            if let Ok(r) = serde_json::from_str::<ImportAnalyzeResponse>(json_text) {
                parsed = Some(r);
                break;
            }
        }
    }

    let mut result = parsed.unwrap_or_default();
    if !stderr.trim().is_empty() {
        result.logs.push(stderr.trim().to_string());
    }

    if !output.status.success() {
        if result.failed.is_empty() {
            result.failed.push(format!(
                "Analyzer failed with status {}",
                output.status.code().unwrap_or(-1)
            ));
        }
    }

    Ok(result)
}

#[tauri::command]
fn import_and_analyze_songs(file_paths: Vec<String>) -> Result<ImportAnalyzeResponse, String> {
    if file_paths.is_empty() {
        return Ok(ImportAnalyzeResponse::default());
    }

    let script_path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.join("tools").join("audio_analyzer").join("analyze.py"))
        .ok_or_else(|| "Failed to resolve analyze.py path".to_string())?;

    if !script_path.exists() {
        return Err(format!("Analyzer script not found: {}", script_path.display()));
    }

    let project_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "Failed to resolve project root".to_string())?;
    let venv_python = project_root
        .join("tools")
        .join("audio_analyzer")
        .join(".venv")
        .join("Scripts")
        .join("python.exe");

    if venv_python.exists() {
        if let Ok(r) = run_analyzer_with(
            &venv_python.to_string_lossy(),
            &[],
            &script_path,
            &file_paths,
        ) {
            return Ok(r);
        }
    }

    match run_analyzer_with("python", &[], &script_path, &file_paths) {
        Ok(r) => Ok(r),
        Err(_) => run_analyzer_with("py", &["-3.12"], &script_path, &file_paths)
            .or_else(|_| run_analyzer_with("py", &["-3.11"], &script_path, &file_paths))
            .or_else(|_| run_analyzer_with("py", &["-3.10"], &script_path, &file_paths))
            .or_else(|_| run_analyzer_with("py", &["-3"], &script_path, &file_paths)),
    }
}

#[tauri::command]
fn pick_audio_files(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let picked = app
        .dialog()
        .file()
        .add_filter("Audio", &["mp3", "wav"])
        .blocking_pick_files()
        .unwrap_or_default();

    let mut out = Vec::new();
    for fp in picked {
        if let Ok(p) = fp.into_path() {
            out.push(p.to_string_lossy().to_string());
        }
    }
    Ok(out)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Mutex::new(StreamState::default()))
        .invoke_handler(tauri::generate_handler![
            list_input_devices,
            start_stream,
            stop_stream,
            get_input_level,
            get_pitch_data,
            recommend_songs,
            recommend_imported_songs,
            import_and_analyze_songs,
            pick_audio_files
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

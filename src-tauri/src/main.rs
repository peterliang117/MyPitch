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

/// Resolve the resource root directory at runtime.
///
/// Release (installed) mode: resources sit next to the executable.
/// The NSIS installer lays out:
///   $INSTDIR/mypitch.exe
///   $INSTDIR/resources/songs.csv
///   $INSTDIR/tools/audio_analyzer/analyze.py
///
/// Dev mode (`cargo tauri dev`): CARGO_MANIFEST_DIR points to src-tauri/.
pub(crate) fn resource_root() -> PathBuf {
    // In debug (dev) builds, use the compile-time project path
    #[cfg(debug_assertions)]
    {
        return PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    }

    // In release builds, always resolve relative to the running executable
    #[cfg(not(debug_assertions))]
    {
        if let Ok(exe) = std::env::current_exe() {
            // canonicalize resolves symlinks so we get the real install dir
            let real_exe = exe.canonicalize().unwrap_or(exe);
            if let Some(exe_dir) = real_exe.parent() {
                return exe_dir.to_path_buf();
            }
        }
        // Last resort — should never happen in practice
        PathBuf::from(".")
    }
}

/// Resolve the project root.
/// Dev mode: parent of src-tauri/ (i.e. the repo root).
/// Release mode: same as exe dir (resources are beside the exe).
pub(crate) fn project_root() -> PathBuf {
    let res_root = resource_root();

    #[cfg(debug_assertions)]
    {
        // res_root = src-tauri/, parent = project root
        return res_root.parent().unwrap_or(&res_root).to_path_buf();
    }

    #[cfg(not(debug_assertions))]
    {
        res_root
    }
}

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
    let root = project_root();

    let mut cmd = Command::new(python_cmd);
    let output = cmd
        .args(python_args)
        .arg(script_path)
        .args(file_paths)
        .current_dir(&root)
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

    let root = project_root();
    let script_path = root.join("tools").join("audio_analyzer").join("analyze.py");

    if !script_path.exists() {
        return Err(format!(
            "Analyzer script not found: {}\n\
             Song import requires Python 3.10+ with librosa.\n\
             See the README for setup instructions.",
            script_path.display()
        ));
    }

    let venv_python = root
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

// ==================== PYTHON ENV DETECTION & SETUP ====================

#[derive(Serialize)]
struct PythonEnvStatus {
    python_found: bool,
    python_version: String,
    python_path: String,
    venv_exists: bool,
    deps_installed: bool,
    missing_deps: Vec<String>,
    script_found: bool,
    script_path: String,
    ready: bool,
}

/// Try running a python command and return (version_string, executable_path)
fn try_python(cmd: &str, args: &[&str]) -> Option<(String, String)> {
    let mut c = Command::new(cmd);
    c.args(args).arg("--version");
    if let Ok(output) = c.output() {
        if output.status.success() {
            let ver = String::from_utf8_lossy(&output.stdout).trim().to_string();
            // Resolve full path
            let mut which = Command::new(if cfg!(windows) { "where" } else { "which" });
            which.arg(cmd);
            let path = if let Ok(w) = which.output() {
                String::from_utf8_lossy(&w.stdout).lines().next().unwrap_or(cmd).trim().to_string()
            } else {
                cmd.to_string()
            };
            return Some((ver, path));
        }
    }
    None
}

#[tauri::command]
fn check_python_env() -> PythonEnvStatus {
    let root = project_root();
    let venv_dir = root.join("tools").join("audio_analyzer").join(".venv");
    let venv_python = venv_dir.join("Scripts").join("python.exe");
    let venv_exists = venv_python.exists();

    // 1. Find a working python
    let (py_found, py_ver, py_path) = if venv_exists {
        let ver = Command::new(&venv_python)
            .arg("--version")
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
            .unwrap_or_default();
        (true, ver, venv_python.to_string_lossy().to_string())
    } else {
        // Try system python in order of preference
        try_python("python", &[])
            .or_else(|| try_python("python3", &[]))
            .or_else(|| try_python("py", &["-3"]))
            .map(|(v, p)| (true, v, p))
            .unwrap_or((false, String::new(), String::new()))
    };

    let script_path = root.join("tools").join("audio_analyzer").join("analyze.py");
    let script_exists = script_path.exists();
    let script_path_str = script_path.to_string_lossy().to_string();

    if !py_found {
        return PythonEnvStatus {
            python_found: false,
            python_version: String::new(),
            python_path: String::new(),
            venv_exists: false,
            deps_installed: false,
            missing_deps: vec!["librosa".into(), "numpy".into(), "soundfile".into()],
            script_found: script_exists,
            script_path: script_path_str,
            ready: false,
        };
    }

    // 2. Check which deps are installed
    let check_python = if venv_exists {
        venv_python.to_string_lossy().to_string()
    } else {
        py_path.clone()
    };

    let required = ["librosa", "numpy", "soundfile"];
    let mut missing = Vec::new();
    for dep in &required {
        let ok = Command::new(&check_python)
            .args(["-c", &format!("import {dep}")])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if !ok {
            missing.push(dep.to_string());
        }
    }

    let deps_ok = missing.is_empty();

    PythonEnvStatus {
        python_found: true,
        python_version: py_ver,
        python_path: py_path,
        venv_exists,
        deps_installed: deps_ok,
        missing_deps: missing,
        script_found: script_exists,
        script_path: script_path_str,
        // Ready = python + deps installed. Script is bundled and should always
        // be there, but don't block the UI if the path check fails — the import
        // command will give a clear error message instead.
        ready: py_found && deps_ok,
    }
}

#[derive(Serialize)]
struct SetupProgress {
    step: String,
    success: bool,
    message: String,
}

#[tauri::command]
fn setup_python_env() -> Vec<SetupProgress> {
    let mut progress = Vec::new();
    let root = project_root();
    let analyzer_dir = root.join("tools").join("audio_analyzer");
    let venv_dir = analyzer_dir.join(".venv");
    let venv_python = venv_dir.join("Scripts").join("python.exe");
    let requirements = analyzer_dir.join("requirements.txt");

    // 1. Find system python
    let system_python = try_python("python", &[])
        .or_else(|| try_python("python3", &[]))
        .or_else(|| try_python("py", &["-3"]));

    let (py_ver, py_cmd) = match system_python {
        Some((ver, path)) => {
            progress.push(SetupProgress {
                step: "detect_python".into(),
                success: true,
                message: format!("Found {ver} at {path}"),
            });
            (ver, path)
        }
        None => {
            progress.push(SetupProgress {
                step: "detect_python".into(),
                success: false,
                message: "Python not found. Please install Python 3.10+ from python.org and restart MyPitch.".into(),
            });
            return progress;
        }
    };

    // Check version is >= 3.10
    let ver_parts: Vec<u32> = py_ver
        .replace("Python ", "")
        .split('.')
        .filter_map(|s| s.parse().ok())
        .collect();
    if ver_parts.len() >= 2 && (ver_parts[0] < 3 || (ver_parts[0] == 3 && ver_parts[1] < 10)) {
        progress.push(SetupProgress {
            step: "check_version".into(),
            success: false,
            message: format!("Python 3.10+ required but found {py_ver}. Please upgrade from python.org."),
        });
        return progress;
    }

    // 2. Create venv if not exists
    if !venv_python.exists() {
        let output = Command::new(&py_cmd)
            .args(["-m", "venv"])
            .arg(&venv_dir)
            .output();
        match output {
            Ok(o) if o.status.success() => {
                progress.push(SetupProgress {
                    step: "create_venv".into(),
                    success: true,
                    message: "Created virtual environment".into(),
                });
            }
            Ok(o) => {
                let err = String::from_utf8_lossy(&o.stderr);
                progress.push(SetupProgress {
                    step: "create_venv".into(),
                    success: false,
                    message: format!("Failed to create venv: {err}"),
                });
                return progress;
            }
            Err(e) => {
                progress.push(SetupProgress {
                    step: "create_venv".into(),
                    success: false,
                    message: format!("Failed to run python: {e}"),
                });
                return progress;
            }
        }
    } else {
        progress.push(SetupProgress {
            step: "create_venv".into(),
            success: true,
            message: "Virtual environment already exists".into(),
        });
    }

    // 3. Install requirements
    let pip_args = if requirements.exists() {
        vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "-r".to_string(),
            requirements.to_string_lossy().to_string(),
        ]
    } else {
        // Fall back to inline deps
        vec![
            "-m".to_string(),
            "pip".to_string(),
            "install".to_string(),
            "numpy==1.26.4".to_string(),
            "librosa==0.10.2.post1".to_string(),
            "soundfile==0.12.1".to_string(),
        ]
    };

    let output = Command::new(&venv_python)
        .args(&pip_args)
        .output();

    match output {
        Ok(o) if o.status.success() => {
            progress.push(SetupProgress {
                step: "install_deps".into(),
                success: true,
                message: "Installed librosa, numpy, soundfile".into(),
            });
        }
        Ok(o) => {
            let err = String::from_utf8_lossy(&o.stderr);
            progress.push(SetupProgress {
                step: "install_deps".into(),
                success: false,
                message: format!("pip install failed: {err}"),
            });
            return progress;
        }
        Err(e) => {
            progress.push(SetupProgress {
                step: "install_deps".into(),
                success: false,
                message: format!("Failed to run pip: {e}"),
            });
            return progress;
        }
    }

    // 4. Verify everything works
    let verify = Command::new(&venv_python)
        .args(["-c", "import librosa; import numpy; import soundfile; print('OK')"])
        .output();
    match verify {
        Ok(o) if o.status.success() => {
            progress.push(SetupProgress {
                step: "verify".into(),
                success: true,
                message: "All dependencies verified successfully".into(),
            });
        }
        _ => {
            progress.push(SetupProgress {
                step: "verify".into(),
                success: false,
                message: "Verification failed — some imports still missing".into(),
            });
        }
    }

    progress
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
            pick_audio_files,
            check_python_env,
            setup_python_env
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

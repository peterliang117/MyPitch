use serde::Serialize;
use yin::Yin;

#[derive(Clone, Serialize)]
pub struct PitchData {
    pub frequency_hz: Option<f32>,
    pub confidence: f32,
    pub note_name: Option<String>,
    pub cents_offset: Option<f32>,
}

impl Default for PitchData {
    fn default() -> Self {
        Self {
            frequency_hz: None,
            confidence: 0.0,
            note_name: None,
            cents_offset: None,
        }
    }
}

pub struct PitchDetector {
    yin: Yin,
    frame_size: usize,
    hop_size: usize,
    sample_rate: u32,
}

impl PitchDetector {
    pub fn new(sample_rate: u32, frame_size: usize, hop_size: usize) -> Self {
        Self {
            yin: Yin::init(0.15, 60.0, 1200.0, sample_rate as usize),
            frame_size,
            hop_size,
            sample_rate,
        }
    }

    pub fn frame_size(&self) -> usize {
        self.frame_size
    }

    pub fn hop_size(&self) -> usize {
        self.hop_size
    }

    pub fn detect(&mut self, frame: &[f32]) -> PitchData {
        if frame.len() < self.frame_size {
            return PitchData::default();
        }

        let frame64: Vec<f64> = frame.iter().map(|v| *v as f64).collect();
        let frequency = self.yin.estimate_freq(&frame64) as f32;

        if !frequency.is_finite() || frequency <= 0.0 {
            return PitchData::default();
        }

        let confidence = estimate_confidence(frame, self.sample_rate as f32, frequency);

        let (note_name, cents_offset) = if confidence >= 0.08 {
            let (name, cents) = frequency_to_note(frequency);
            (Some(name), Some(cents))
        } else {
            (None, None)
        };

        PitchData {
            frequency_hz: Some(frequency),
            confidence,
            note_name,
            cents_offset,
        }
    }
}

fn estimate_confidence(frame: &[f32], sample_rate: f32, frequency_hz: f32) -> f32 {
    if frequency_hz <= 0.0 {
        return 0.0;
    }

    let lag = (sample_rate / frequency_hz).round() as usize;
    if lag == 0 || lag >= frame.len() {
        return 0.0;
    }

    let count = frame.len() - lag;
    if count == 0 {
        return 0.0;
    }

    let mut numerator = 0.0f64;
    let mut energy_a = 0.0f64;
    let mut energy_b = 0.0f64;

    for i in 0..count {
        let a = frame[i] as f64;
        let b = frame[i + lag] as f64;
        numerator += a * b;
        energy_a += a * a;
        energy_b += b * b;
    }

    if energy_a <= f64::EPSILON || energy_b <= f64::EPSILON {
        return 0.0;
    }

    let norm = numerator / (energy_a.sqrt() * energy_b.sqrt());
    norm.clamp(0.0, 1.0) as f32
}

fn frequency_to_note(frequency_hz: f32) -> (String, f32) {
    let midi = 69.0 + 12.0 * (frequency_hz / 440.0).log2();
    let nearest = midi.round();
    let cents_offset = (midi - nearest) * 100.0;

    let note_names = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];

    let nearest_i = nearest as i32;
    let note_index = ((nearest_i % 12) + 12) % 12;
    let octave = nearest_i / 12 - 1;

    (format!("{}{}", note_names[note_index as usize], octave), cents_offset)
}

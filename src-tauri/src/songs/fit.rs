use serde::Serialize;

#[derive(Clone, Serialize)]
pub struct FitDetail {
    pub shift: i32,
    pub final_low: i32,
    pub final_high: i32,
    pub final_chorus_high: i32,
    pub headroom_comfort: i32,
    pub headroom_limit: i32,
    pub low_margin: i32,
    pub shift_penalty: f32,
    pub range_penalty: f32,
    pub chorus_penalty: f32,
    pub high_note_penalty: f32,
    pub low_penalty: f32,
    pub total_score: f32,
}

pub struct FitConfig {
    pub shift_penalty_per_semitone: f32,
    pub shift_penalty_max: f32,
    pub range_penalty_per_semitone: f32,
    pub range_penalty_max: f32,
    pub chorus_penalty_per_semitone: f32,
    pub chorus_penalty_max: f32,
    pub high_note_over_per_semitone: f32,
    pub high_note_count_cap: i32,
    pub high_note_count_factor: f32,
    pub high_note_ms_factor: f32,
    pub high_note_penalty_max: f32,
    pub low_penalty_per_semitone: f32,
    pub low_penalty_max: f32,
}

pub const FIT_CONFIG: FitConfig = FitConfig {
    shift_penalty_per_semitone: 6.0,
    shift_penalty_max: 30.0,
    range_penalty_per_semitone: 4.0,
    range_penalty_max: 25.0,
    chorus_penalty_per_semitone: 5.0,
    chorus_penalty_max: 20.0,
    high_note_over_per_semitone: 3.0,
    high_note_count_cap: 10,
    high_note_count_factor: 0.8,
    high_note_ms_factor: 5.0,
    high_note_penalty_max: 15.0,
    low_penalty_per_semitone: 5.0,
    low_penalty_max: 10.0,
};

pub fn clamp(min_v: f32, max_v: f32, v: f32) -> f32 {
    v.max(min_v).min(max_v)
}

pub fn compute_fit_detail(
    shift: i32,
    user_low: i32,
    user_high: i32,
    comfort_high: i32,
    melody_low: i32,
    melody_high: i32,
    chorus_high: i32,
    high_note_count: i32,
    high_note_max_midi: i32,
    high_note_total_ms: i32,
) -> FitDetail {
    let final_low = melody_low + shift;
    let final_high = melody_high + shift;
    let final_chorus_high = chorus_high + shift;

    let headroom_comfort = comfort_high - final_high;
    let headroom_limit = user_high - final_high;
    let low_margin = final_low - user_low;

    let shift_penalty = clamp(
        0.0,
        FIT_CONFIG.shift_penalty_max,
        shift.abs() as f32 * FIT_CONFIG.shift_penalty_per_semitone,
    );

    let range_penalty = clamp(
        0.0,
        FIT_CONFIG.range_penalty_max,
        (final_high - comfort_high).max(0) as f32 * FIT_CONFIG.range_penalty_per_semitone,
    );

    let chorus_penalty = clamp(
        0.0,
        FIT_CONFIG.chorus_penalty_max,
        (final_chorus_high - comfort_high).max(0) as f32 * FIT_CONFIG.chorus_penalty_per_semitone,
    );

    let high_note_penalty = clamp(
        0.0,
        FIT_CONFIG.high_note_penalty_max,
        (high_note_max_midi + shift - comfort_high).max(0) as f32 * FIT_CONFIG.high_note_over_per_semitone
            + high_note_count.min(FIT_CONFIG.high_note_count_cap) as f32 * FIT_CONFIG.high_note_count_factor
            + (high_note_total_ms as f32 / 3000.0) * FIT_CONFIG.high_note_ms_factor,
    );

    let low_penalty = clamp(
        0.0,
        FIT_CONFIG.low_penalty_max,
        (user_low - final_low).max(0) as f32 * FIT_CONFIG.low_penalty_per_semitone,
    );

    let total_score = clamp(
        0.0,
        100.0,
        100.0 - shift_penalty - range_penalty - chorus_penalty - high_note_penalty - low_penalty,
    );

    FitDetail {
        shift,
        final_low,
        final_high,
        final_chorus_high,
        headroom_comfort,
        headroom_limit,
        low_margin,
        shift_penalty,
        range_penalty,
        chorus_penalty,
        high_note_penalty,
        low_penalty,
        total_score,
    }
}

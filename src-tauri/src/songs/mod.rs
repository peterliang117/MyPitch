pub mod fit;

use fit::{compute_fit_detail, FitDetail};
use serde::Serialize;
use std::path::Path;

#[derive(Clone)]
pub struct SongEntry {
    pub title: String,
    pub artist: String,
    pub melody_low_midi: i32,
    pub melody_high_midi: i32,
    pub chorus_low_midi: i32,
    pub chorus_high_midi: i32,
    pub high_note_count: i32,
    pub high_note_max_midi: i32,
    pub high_note_total_ms: i32,
    pub is_imported: bool,
}

#[derive(Clone, Serialize)]
pub struct SongRecommendation {
    pub title: String,
    pub artist: String,
    pub shift: i32,
    pub fit_score: i32,
    pub fit_detail: FitDetail,
    pub original_low_midi: i32,
    pub original_high_midi: i32,
    pub original_chorus_low_midi: i32,
    pub original_chorus_high_midi: i32,
    pub shifted_low_midi: i32,
    pub shifted_high_midi: i32,
    pub shifted_chorus_low_midi: i32,
    pub shifted_chorus_high_midi: i32,
    pub is_original_key: bool,
    pub is_imported: bool,
}

pub fn parse_song_library() -> Vec<SongEntry> {
    let mut all = Vec::new();
    let res_root = crate::resource_root();
    let proj_root = crate::project_root();

    let base = res_root.join("resources").join("songs.csv");
    // In dev mode, generated csv is at <project>/assets/songs_generated.csv
    // In release mode, it's at <exe_dir>/assets/songs_generated.csv
    let generated = proj_root.join("assets").join("songs_generated.csv");

    all.extend(parse_song_csv_file(&base, false));
    all.extend(parse_song_csv_file(&generated, true));
    all
}

fn parse_song_csv_file(path: &Path, is_imported: bool) -> Vec<SongEntry> {
    if !path.exists() {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut reader = match csv::ReaderBuilder::new().flexible(true).from_path(path) {
        Ok(r) => r,
        Err(_) => return Vec::new(),
    };

    for rec in reader.records().flatten() {
        let get = |i: usize| rec.get(i).map(|s| s.trim()).unwrap_or_default();

        let low = get(2).parse::<i32>().ok();
        let high = get(3).parse::<i32>().ok();
        let chorus_low = get(4).parse::<i32>().ok();
        let chorus_high = get(5).parse::<i32>().ok();
        let hn_count = get(6).parse::<i32>().ok();
        let hn_max = get(7).parse::<i32>().ok();
        let hn_ms = get(8).parse::<i32>().ok();

        let (
            Some(melody_low_midi),
            Some(melody_high_midi),
            Some(chorus_low_midi),
            Some(chorus_high_midi),
            Some(high_note_count),
            Some(high_note_max_midi),
            Some(high_note_total_ms),
        ) = (low, high, chorus_low, chorus_high, hn_count, hn_max, hn_ms)
        else {
            continue;
        };

        out.push(SongEntry {
            title: get(0).to_string(),
            artist: get(1).to_string(),
            melody_low_midi,
            melody_high_midi,
            chorus_low_midi,
            chorus_high_midi,
            high_note_count,
            high_note_max_midi,
            high_note_total_ms,
            is_imported,
        });
    }

    out
}

pub fn pick_shift(song: &SongEntry, user_low: i32, user_high: i32, comfort_high: i32) -> Option<i32> {
    let min_shift = user_low - song.melody_low_midi;
    let max_shift = user_high - song.melody_high_midi;
    if min_shift > max_shift {
        return None;
    }

    let mut candidates: Vec<i32> = (min_shift..=max_shift).collect();
    if candidates.is_empty() {
        return None;
    }

    let mut comfort_candidates: Vec<i32> = candidates
        .iter()
        .copied()
        .filter(|shift| song.melody_high_midi + shift <= comfort_high)
        .collect();

    if !comfort_candidates.is_empty() {
        comfort_candidates.sort_by_key(|shift| {
            let shifted_high = song.melody_high_midi + shift;
            let toward_top = comfort_high - shifted_high;
            (toward_top, shift.abs())
        });
        return comfort_candidates.first().copied();
    }

    candidates.sort_by_key(|shift| {
        let shifted_high = song.melody_high_midi + shift;
        let over_comfort = shifted_high - comfort_high;
        (over_comfort, shift.abs())
    });

    candidates.first().copied()
}

fn pick_shift_relaxed(song: &SongEntry, user_low: i32, user_high: i32, comfort_high: i32) -> i32 {
    let center_shift = comfort_high - song.melody_high_midi;
    let mut best_shift = center_shift;
    let mut best_key = (i32::MAX, i32::MAX, i32::MAX);

    for shift in (center_shift - 12)..=(center_shift + 12) {
        let final_low = song.melody_low_midi + shift;
        let final_high = song.melody_high_midi + shift;
        let below = (user_low - final_low).max(0);
        let above = (final_high - user_high).max(0);
        let violation = below + above;
        let comfort_over = (final_high - comfort_high).max(0);
        let key = (violation, shift.abs(), comfort_over);
        if key < best_key {
            best_key = key;
            best_shift = shift;
        }
    }

    best_shift
}

fn build_recommendation(
    song: &SongEntry,
    shift: i32,
    user_low_midi: i32,
    user_high_midi: i32,
    comfort_high_midi: i32,
) -> SongRecommendation {
    let fit_detail = compute_fit_detail(
        shift,
        user_low_midi,
        user_high_midi,
        comfort_high_midi,
        song.melody_low_midi,
        song.melody_high_midi,
        song.chorus_high_midi,
        song.high_note_count,
        song.high_note_max_midi,
        song.high_note_total_ms,
    );
    let fit_score = fit_detail.total_score.round() as i32;

    SongRecommendation {
        title: song.title.clone(),
        artist: song.artist.clone(),
        shift,
        fit_score,
        fit_detail,
        original_low_midi: song.melody_low_midi,
        original_high_midi: song.melody_high_midi,
        original_chorus_low_midi: song.chorus_low_midi,
        original_chorus_high_midi: song.chorus_high_midi,
        shifted_low_midi: song.melody_low_midi + shift,
        shifted_high_midi: song.melody_high_midi + shift,
        shifted_chorus_low_midi: song.chorus_low_midi + shift,
        shifted_chorus_high_midi: song.chorus_high_midi + shift,
        is_original_key: shift == 0,
        is_imported: song.is_imported,
    }
}

fn sort_recommendations(recs: &mut [SongRecommendation]) {
    recs.sort_by(|a, b| {
        b.fit_detail
            .total_score
            .total_cmp(&a.fit_detail.total_score)
            .then(a.shift.abs().cmp(&b.shift.abs()))
            .then(
                (a.shifted_high_midi - a.shifted_low_midi)
                    .cmp(&(b.shifted_high_midi - b.shifted_low_midi)),
            )
    });
}

pub fn recommend_songs_internal(
    user_low_midi: i32,
    user_high_midi: i32,
    _comfort_low_midi: i32,
    comfort_high_midi: i32,
) -> Vec<SongRecommendation> {
    let songs = parse_song_library();
    let mut recs: Vec<SongRecommendation> = Vec::new();

    for song in &songs {
        let shift = if song.is_imported {
            pick_shift(song, user_low_midi, user_high_midi, comfort_high_midi)
                .unwrap_or_else(|| pick_shift_relaxed(song, user_low_midi, user_high_midi, comfort_high_midi))
        } else {
            let Some(shift) = pick_shift(song, user_low_midi, user_high_midi, comfort_high_midi) else {
                continue;
            };
            shift
        };

        let final_low = song.melody_low_midi + shift;
        let final_high = song.melody_high_midi + shift;

        if !song.is_imported && (final_low < user_low_midi || final_high > user_high_midi) {
            continue;
        }

        recs.push(build_recommendation(song, shift, user_low_midi, user_high_midi, comfort_high_midi));
    }

    sort_recommendations(&mut recs);

    if recs.is_empty() {
        for song in &songs {
            let shift = pick_shift_relaxed(song, user_low_midi, user_high_midi, comfort_high_midi);
            recs.push(build_recommendation(song, shift, user_low_midi, user_high_midi, comfort_high_midi));
        }
        sort_recommendations(&mut recs);
    }

    recs
}

#[cfg(test)]
mod tests {
    use super::recommend_songs_internal;

    #[test]
    fn print_mock_top10() {
        let recs = recommend_songs_internal(45, 69, 48, 64);
        for (idx, s) in recs.iter().take(10).enumerate() {
            println!(
                "{:02}. {} - {} | score={} shift={} final_high={}",
                idx + 1,
                s.title,
                s.artist,
                s.fit_score,
                s.shift,
                s.shifted_high_midi
            );
        }
        assert!(!recs.is_empty());
    }
}

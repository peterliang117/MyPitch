#!/usr/bin/env python3
import argparse
import csv
import json
import os
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Dict, List, Tuple

import librosa
import numpy as np

ANALYSIS_VERSION = "v1.0-pyin"
FRAME_LENGTH = 2048
HOP_LENGTH = 256
VOICED_PROB_THRESHOLD = 0.7


@dataclass
class AnalyzeRow:
    title: str
    artist: str
    melody_low_midi: int
    melody_high_midi: int
    chorus_low_midi: int
    chorus_high_midi: int
    high_note_count: int
    high_note_max_midi: int
    high_note_total_ms: int
    source_path: str
    analyzed_at: str
    analysis_version: str


CSV_FIELDS = [
    "title",
    "artist",
    "melody_low_midi",
    "melody_high_midi",
    "chorus_low_midi",
    "chorus_high_midi",
    "high_note_count",
    "high_note_max_midi",
    "high_note_total_ms",
    "source_path",
    "analyzed_at",
    "analysis_version",
]


def run_demucs(input_path: Path, out_root: Path, logs: List[str]) -> Tuple[Path, bool]:
    out_root.mkdir(parents=True, exist_ok=True)
    cmd = [
        "demucs",
        "--two-stems",
        "vocals",
        "-n",
        "htdemucs",
        "-o",
        str(out_root),
        str(input_path),
    ]
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    except FileNotFoundError:
        logs.append(f"demucs not found, fallback to original audio: {input_path.name}")
        return input_path, False

    if proc.returncode != 0:
        logs.append(
            f"demucs failed for {input_path.name}, fallback to original audio: {proc.stderr.strip()[:200]}"
        )
        return input_path, False

    vocal_path = out_root / "htdemucs" / input_path.stem / "vocals.wav"
    if not vocal_path.exists():
        logs.append(f"demucs output missing vocals.wav for {input_path.name}, fallback to original")
        return input_path, False

    logs.append(f"demucs ok: {input_path.name}")
    return vocal_path, True


def contiguous_high_note_segments(is_high: np.ndarray, frame_ms: float) -> int:
    idx = np.flatnonzero(is_high)
    if idx.size == 0:
        return 0

    gap_allow_frames = max(0, int(round(80.0 / frame_ms)))
    min_segment_frames = max(1, int(round(200.0 / frame_ms)))

    count = 0
    seg_start = int(idx[0])
    seg_end = int(idx[0])

    for raw in idx[1:]:
        i = int(raw)
        if i - seg_end - 1 <= gap_allow_frames:
            seg_end = i
        else:
            if (seg_end - seg_start + 1) >= min_segment_frames:
                count += 1
            seg_start = i
            seg_end = i

    if (seg_end - seg_start + 1) >= min_segment_frames:
        count += 1

    return count


def analyze_audio(path_for_pitch: Path, source_path: Path, logs: List[str]) -> AnalyzeRow:
    y, sr = librosa.load(str(path_for_pitch), sr=22050, mono=True)
    f0, voiced_flag, voiced_prob = librosa.pyin(
        y,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        frame_length=FRAME_LENGTH,
        hop_length=HOP_LENGTH,
    )

    if f0 is None:
        raise RuntimeError("pyin returned no output")

    if voiced_flag is None:
        voiced_flag = np.zeros_like(f0, dtype=bool)
    if voiced_prob is None:
        voiced_prob = np.zeros_like(f0, dtype=float)

    mask = np.isfinite(f0) & voiced_flag & (voiced_prob >= VOICED_PROB_THRESHOLD)
    voiced_f0 = f0[mask]

    if voiced_f0.size < 20:
        raise RuntimeError("too few voiced frames for stable analysis")

    midi = 69.0 + 12.0 * np.log2(voiced_f0 / 440.0)

    melody_low = int(round(float(np.percentile(midi, 1))))
    melody_high = int(round(float(np.percentile(midi, 99))))
    high_note_max = int(round(float(np.percentile(midi, 99.5))))

    threshold = melody_high - 2
    is_high = midi >= threshold

    frame_ms = (HOP_LENGTH / float(sr)) * 1000.0
    high_note_total_ms = int(round(float(np.sum(is_high)) * frame_ms))
    high_note_count = contiguous_high_note_segments(is_high, frame_ms)

    now_iso = datetime.now(timezone.utc).isoformat()

    return AnalyzeRow(
        title=source_path.stem,
        artist="",
        melody_low_midi=melody_low,
        melody_high_midi=melody_high,
        chorus_low_midi=melody_low,
        chorus_high_midi=melody_high,
        high_note_count=int(high_note_count),
        high_note_max_midi=high_note_max,
        high_note_total_ms=int(high_note_total_ms),
        source_path=str(source_path.resolve()),
        analyzed_at=now_iso,
        analysis_version=ANALYSIS_VERSION,
    )


def load_existing_rows(path: Path) -> Dict[str, Dict[str, str]]:
    if not path.exists():
        return {}

    existing: Dict[str, Dict[str, str]] = {}
    with path.open("r", newline="", encoding="utf-8") as f:
        reader = csv.DictReader(f)
        for row in reader:
            key = row.get("source_path", "").strip()
            if key:
                existing[key] = row
    return existing


def write_rows(path: Path, rows: Dict[str, Dict[str, str]]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for key in sorted(rows.keys()):
            writer.writerow(rows[key])


def row_to_dict(row: AnalyzeRow) -> Dict[str, str]:
    return {
        "title": row.title,
        "artist": row.artist,
        "melody_low_midi": str(row.melody_low_midi),
        "melody_high_midi": str(row.melody_high_midi),
        "chorus_low_midi": str(row.chorus_low_midi),
        "chorus_high_midi": str(row.chorus_high_midi),
        "high_note_count": str(row.high_note_count),
        "high_note_max_midi": str(row.high_note_max_midi),
        "high_note_total_ms": str(row.high_note_total_ms),
        "source_path": row.source_path,
        "analyzed_at": row.analyzed_at,
        "analysis_version": row.analysis_version,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze mp3/wav and generate singability metadata")
    parser.add_argument("files", nargs="+", help="Input audio files")
    parser.add_argument(
        "--output",
        default=str((Path(__file__).resolve().parents[2] / "assets" / "songs_generated.csv")),
        help="Output csv path",
    )
    parser.add_argument("--no-sep", action="store_true", help="Skip vocal separation")
    args = parser.parse_args()

    logs: List[str] = []
    failed: List[str] = []
    added = 0

    out_csv = Path(args.output)
    rows = load_existing_rows(out_csv)

    with tempfile.TemporaryDirectory(prefix="mypitch_sep_") as td:
        sep_root = Path(td)

        for f in args.files:
            source = Path(f)
            if not source.exists():
                failed.append(f"{f}: file not found")
                continue

            if source.suffix.lower() not in {".mp3", ".wav"}:
                failed.append(f"{source.name}: unsupported extension")
                continue

            try:
                pitch_input = source
                if not args.no_sep:
                    pitch_input, _ = run_demucs(source, sep_root, logs)
                else:
                    logs.append(f"skip separation (--no-sep): {source.name}")

                row = analyze_audio(pitch_input, source, logs)
                rows[row.source_path] = row_to_dict(row)
                added += 1
                logs.append(f"analyzed: {source.name}")
            except Exception as e:
                failed.append(f"{source.name}: {e}")

    write_rows(out_csv, rows)

    result = {
        "added": added,
        "failed": failed,
        "logs": logs,
        "output": str(out_csv.resolve()),
    }
    print("RESULT_JSON:" + json.dumps(result, ensure_ascii=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

# MyPitch (Tauri v2 + React + Vite + TypeScript)

Desktop app for voice range testing and song recommendation.

## Windows prerequisites

1. Node.js 20+ (LTS): https://nodejs.org/
2. Rust (stable): https://rustup.rs/
3. Microsoft C++ Build Tools (Desktop development with C++)
4. WebView2 Runtime (usually preinstalled on Windows 11)
5. Python 3.10+

## Install app dependencies

```powershell
npm install
```

## Install audio analyzer dependencies (Python)

```powershell
python -m pip install -r tools/audio_analyzer/requirements.txt
```

Optional vocal separation (recommended):

```powershell
python -m pip install demucs
```

If `demucs` is not installed, analyzer auto-falls back to no-separation mode.

## Run desktop app

```powershell
cargo tauri dev
```

## Song import and analysis

### In app

1. Open `Song Library` page.
2. Click `Import Audio` and select one or more `.mp3/.wav` files.
3. App runs `tools/audio_analyzer/analyze.py` and updates `assets/songs_generated.csv`.
4. Open `Recommendations` page to see new songs participate in ranking.

### CLI batch mode

```powershell
python tools/audio_analyzer/analyze.py "C:\path\song1.mp3" "C:\path\song2.wav"
```

Output file:

- `assets/songs_generated.csv`

## Data files

- Base library: `src-tauri/resources/songs.csv`
- Generated library: `assets/songs_generated.csv`

Recommendations merge both files at runtime.

## Verification steps

```powershell
cd C:\Users\zicon\Repo\MyPitch
npx tsc --noEmit
cargo check --manifest-path .\src-tauri\Cargo.toml
cargo test --manifest-path .\src-tauri\Cargo.toml print_mock_top10 -- --nocapture
```

Manual end-to-end verification:

1. Run `cargo tauri dev`.
2. Finish range test on `Test Live`.
3. Import one local mp3 in `Song Library`.
4. Open `Recommendations` and confirm imported songs are included.

## What was implemented (current milestone)

- Built Tauri v2 + React + Vite (TypeScript) desktop skeleton (Windows-first).
- Added pages: `Home`, `Test Live`, `Result`, `Song Library`, `Recommendations`.
- Added Tauri commands:
  - `list_input_devices()`
  - `start_stream(device_id?)`
  - `stop_stream()`
  - `recommend_songs(...)`
  - `import_and_analyze_songs(file_paths)`
  - `pick_audio_files()`
- Integrated `cpal` input capture:
  - Input device enumeration
  - Start/stop stream safely
  - RMS level + pitch polling pipeline for live test UI
- Added pitch module (`YIN`) and real-time live display:
  - `frequency_hz`, `confidence`, `note_name`, `cents_offset`
- Implemented free-sing range test flow:
  - Sequential low/high capture stages
  - Stability gate with confidence + RMS thresholds
  - Result output: low/high/comfort range
- Added song library and recommendation engine:
  - Base CSV + generated CSV merge
  - Shift calculation and fit scoring (0-100) with detailed penalties
  - Top-5 default display, expandable list
  - Song detail panel with reason text
- Added local audio analyzer toolchain (`tools/audio_analyzer`):
  - Batch mp3/wav analysis
  - Optional Demucs vocal separation with auto fallback
  - `librosa.pyin` metadata extraction
  - Output to `assets/songs_generated.csv`
- Added import UX improvements:
  - In-app file picker
  - Analyze progress visuals and logs
- Recommendation behavior updated:
  - Imported songs are always included in recommendation results (can still have low score).

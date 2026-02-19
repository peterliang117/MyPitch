import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

type Page = "Home" | "Test Live" | "Result" | "Song Library" | "Recommendations";
type TestStage = "idle" | "capture_low" | "capture_high" | "done";

type InputDeviceInfo = {
  id: string;
  name: string;
  default_sample_rate: number | null;
  channels: number | null;
};

type PitchData = {
  frequency_hz: number | null;
  confidence: number;
  note_name: string | null;
  cents_offset: number | null;
};

type RangeResult = {
  lowMidi: number | null;
  highMidi: number | null;
  comfortLowMidi: number | null;
  comfortHighMidi: number | null;
};

type SongRecommendation = {
  title: string;
  artist: string;
  shift: number;
  fit_score: number;
  fit_detail: {
    shift: number;
    final_low: number;
    final_high: number;
    final_chorus_high: number;
    headroom_comfort: number;
    headroom_limit: number;
    low_margin: number;
    shift_penalty: number;
    range_penalty: number;
    chorus_penalty: number;
    high_note_penalty: number;
    low_penalty: number;
    total_score: number;
  };
  original_low_midi: number;
  original_high_midi: number;
  original_chorus_low_midi: number;
  original_chorus_high_midi: number;
  shifted_low_midi: number;
  shifted_high_midi: number;
  shifted_chorus_low_midi: number;
  shifted_chorus_high_midi: number;
  is_original_key: boolean;
  is_imported: boolean;
};

type ImportAnalyzeResponse = {
  added: number;
  failed: string[];
  logs: string[];
  output?: string;
};

type PythonEnvStatus = {
  python_found: boolean;
  python_version: string;
  python_path: string;
  venv_exists: boolean;
  deps_installed: boolean;
  missing_deps: string[];
  script_found: boolean;
  script_path: string;
  ready: boolean;
};

type SetupProgress = {
  step: string;
  success: boolean;
  message: string;
};

const SELECTED_DEVICE_KEY = "selected_input_device_id";
const CONFIDENCE_THRESHOLD = 0.12;
const CONFIDENCE_PASS_THRESHOLD = 0.55;
const CONFIDENCE_PASS_MS = 250;
const RMS_THRESHOLD = 0.001;
const STABLE_REQUIRED_MS = 600;
const STABLE_NOTE_DELTA = 2.0;
const LEVEL_GAIN = 12;
const SILENCE_RESET_MS = 200;
const HIGH_STAGE_MIN_DELAY_MS = 200;
const HIGH_NOTE_MIN_SEMITONES = 0.5;

function frequencyToMidi(freqHz: number): number {
  return 69 + 12 * Math.log2(freqHz / 440);
}

function midiToNoteName(midi: number): string {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const nearest = Math.round(midi);
  const noteIndex = ((nearest % 12) + 12) % 12;
  const octave = Math.floor(nearest / 12) - 1;
  return `${noteNames[noteIndex]}${octave}`;
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }
  return sorted[mid];
}

function fitBucket(score: number): { label: string; className: string } {
  if (score >= 90) {
    return { label: "Great Fit", className: "great" };
  }
  if (score >= 75) {
    return { label: "Singable", className: "singable" };
  }
  if (score >= 60) {
    return { label: "Challenging", className: "challenging" };
  }
  return { label: "Not Recommended", className: "low" };
}

function buildFitReasons(song: SongRecommendation): string[] {
  const d = song.fit_detail;
  const reasons: string[] = [];

  reasons.push(
    `Key shift ${song.shift > 0 ? `+${song.shift}` : song.shift} semitone(s), final range ${midiToNoteName(d.final_low)}-${midiToNoteName(d.final_high)}.`
  );

  if (d.headroom_comfort >= 0) {
    reasons.push(`Top note stays within comfort zone with ${d.headroom_comfort} semitone headroom.`);
  } else {
    reasons.push(
      `Top note is ${Math.abs(d.headroom_comfort)} semitone(s) above comfort high, may require mix/head voice.`
    );
  }

  if (d.high_note_penalty > 8) {
    reasons.push("Frequent/extended high-note sections increase fatigue risk.");
  } else if (d.shift_penalty > 12) {
    reasons.push("Large transposition needed, pitch color may change from original key.");
  } else {
    reasons.push("High-note load is manageable for your current tested range.");
  }

  return reasons.slice(0, 3);
}

function getVoiceType(lowMidi: number, highMidi: number): { name: string; description: string } {
  const range = highMidi - lowMidi;
  const center = (lowMidi + highMidi) / 2;
  if (center >= 60) {
    return { name: "Soprano Range", description: `Your range spans ${Math.round(range)} semitones in the upper register, typical of a soprano voice.` };
  }
  if (center >= 55) {
    return { name: "Mezzo-Soprano Range", description: `Your range spans ${Math.round(range)} semitones, sitting between soprano and alto registers.` };
  }
  if (center >= 50) {
    return { name: "Alto / Countertenor Range", description: `Your range spans ${Math.round(range)} semitones in the mid-upper register.` };
  }
  if (center >= 45) {
    return { name: "Tenor Range", description: `Your range spans ${Math.round(range)} semitones, comfortable in the tenor register.` };
  }
  if (center >= 40) {
    return { name: "Baritone Range", description: `Your range spans ${Math.round(range)} semitones, comfortable in the mid-low register.` };
  }
  return { name: "Bass Range", description: `Your range spans ${Math.round(range)} semitones in the lower register.` };
}

// SVG icon components
const MicIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
);

const HomeIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>
);

const WaveIcon = () => (
  <svg viewBox="0 0 24 24"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
);

const MusicIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
);

const StarIcon = () => (
  <svg viewBox="0 0 24 24"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
);

const UploadIcon = () => (
  <svg viewBox="0 0 24 24"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
);

const PlayIcon = () => (
  <svg viewBox="0 0 24 24"><polygon points="5 3 19 12 5 21 5 3"/></svg>
);

// Piano key definitions for the result page
const PIANO_KEYS = (() => {
  const keys: { midi: number; name: string; isBlack: boolean }[] = [];
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  // C2 (midi 36) to B4 (midi 71)
  for (let midi = 36; midi <= 71; midi++) {
    const noteIndex = ((midi % 12) + 12) % 12;
    const octave = Math.floor(midi / 12) - 1;
    const isBlack = [1, 3, 6, 8, 10].includes(noteIndex);
    keys.push({ midi, name: `${noteNames[noteIndex]}${octave}`, isBlack });
  }
  return keys;
})();

function App() {
  const [activePage, setActivePage] = useState<Page>("Home");
  const [status, setStatus] = useState("Idle");
  const [devices, setDevices] = useState<InputDeviceInfo[]>([]);
  const [inputLevel, setInputLevel] = useState(0);
  const [rawInputLevel, setRawInputLevel] = useState(0);
  const inputLevelRef = useRef(0);
  const rawInputLevelRef = useRef(0);
  const [pitchData, setPitchData] = useState<PitchData>({
    frequency_hz: null,
    confidence: 0,
    note_name: null,
    cents_offset: null
  });
  const [testStage, setTestStage] = useState<TestStage>("idle");
  const [testInstruction, setTestInstruction] = useState("Click Start Range Test to begin.");
  const [stabilityMs, setStabilityMs] = useState(0);
  const [sampleState, setSampleState] = useState<"idle" | "valid" | "invalid">("idle");
  const [awaitingResultStep, setAwaitingResultStep] = useState(false);
  const [rangeResult, setRangeResult] = useState<RangeResult>({
    lowMidi: null,
    highMidi: null,
    comfortLowMidi: null,
    comfortHighMidi: null
  });
  const [recommendations, setRecommendations] = useState<SongRecommendation[]>([]);
  const [importBusy, setImportBusy] = useState(false);
  const [importLogs, setImportLogs] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<string>("");
  const [importFileCount, setImportFileCount] = useState(0);
  const [pythonEnv, setPythonEnv] = useState<PythonEnvStatus | null>(null);
  const [pythonChecking, setPythonChecking] = useState(false);
  const [pythonSetupBusy, setPythonSetupBusy] = useState(false);
  const [pythonSetupLogs, setPythonSetupLogs] = useState<SetupProgress[]>([]);
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);
  const [showDebug, setShowDebug] = useState(false);
  const [expandedSong, setExpandedSong] = useState<string | null>(null);
  const [showTechDetail, setShowTechDetail] = useState<string | null>(null);
  const [recoFilter, setRecoFilter] = useState<string>("all");

  const pollTimerRef = useRef<number | null>(null);
  const pollErrorCountRef = useRef(0);
  const pollInFlightRef = useRef(false);
  const stageRef = useRef<TestStage>("idle");
  const fastPassRef = useRef<{ stage: TestStage | null; startAt: number | null }>({
    stage: null,
    startAt: null
  });
  const stageEnteredAtRef = useRef<number>(0);
  const waitForSilenceBeforeHighRef = useRef(false);
  const silenceStartRef = useRef<number | null>(null);
  const stableRef = useRef<{ startAt: number | null; lastValidAt: number | null; samples: number[] }>({
    startAt: null,
    lastValidAt: null,
    samples: []
  });
  const lastGoodPitchRef = useRef<number | null>(null);
  const stableHistoryRef = useRef<number[]>([]);
  const lowMidiRef = useRef<number | null>(null);
  const highMidiRef = useRef<number | null>(null);

  const [selectedDeviceId, setSelectedDeviceId] = useState<string | null>(() => {
    const cached = localStorage.getItem(SELECTED_DEVICE_KEY);
    return cached && cached.trim().length > 0 ? cached : null;
  });
  const selectedDeviceIdRef = useRef(selectedDeviceId);
  useEffect(() => {
    selectedDeviceIdRef.current = selectedDeviceId;
  }, [selectedDeviceId]);

  // ==================== LOGIC (unchanged) ====================

  const resetStability = () => {
    stableRef.current = { startAt: null, lastValidAt: null, samples: [] };
    lastGoodPitchRef.current = null;
    setStabilityMs(0);
    setSampleState("idle");
  };

  const resetRangeTest = () => {
    setTestStage("idle");
    stageRef.current = "idle";
    setTestInstruction("Click Start Range Test to begin.");
    lowMidiRef.current = null;
    highMidiRef.current = null;
    stageEnteredAtRef.current = 0;
    fastPassRef.current = { stage: null, startAt: null };
    waitForSilenceBeforeHighRef.current = false;
    silenceStartRef.current = null;
    stableHistoryRef.current = [];
    resetStability();
    setRangeResult({ lowMidi: null, highMidi: null, comfortLowMidi: null, comfortHighMidi: null });
    setAwaitingResultStep(false);
  };

  const finishRangeTest = () => {
    const lowMidi = lowMidiRef.current;
    const highMidi = highMidiRef.current;
    if (lowMidi === null || highMidi === null) {
      setTestInstruction("Range test did not complete. Please try again.");
      setTestStage("idle");
      stageRef.current = "idle";
      return;
    }
    const center = stableHistoryRef.current.length > 0 ? median(stableHistoryRef.current) : (lowMidi + highMidi) / 2;
    const comfortLow = Math.max(lowMidi, center - 3);
    const comfortHigh = Math.min(highMidi, center + 3);
    setRangeResult({ lowMidi, highMidi, comfortLowMidi: comfortLow, comfortHighMidi: comfortHigh });
    setTestInstruction("High note captured. Click Next Step to view result.");
    setTestStage("done");
    stageRef.current = "done";
    setAwaitingResultStep(true);
  };

  const completeStageWithMidi = (stage: TestStage, stableMidi: number, timestamp: number) => {
    resetStability();
    fastPassRef.current = { stage: null, startAt: null };
    if (stage === "capture_low") {
      lowMidiRef.current = stableMidi;
      setRangeResult((prev) => ({ ...prev, lowMidi: stableMidi }));
      setTestInstruction("Low note captured. Now sing your highest comfortable note and hold for 1 second.");
      setTestStage("capture_high");
      stageRef.current = "capture_high";
      stageEnteredAtRef.current = timestamp;
      waitForSilenceBeforeHighRef.current = false;
      silenceStartRef.current = null;
      return;
    }
    if (timestamp - stageEnteredAtRef.current < HIGH_STAGE_MIN_DELAY_MS) {
      return;
    }
    const lowMidi = lowMidiRef.current;
    if (lowMidi !== null && stableMidi < lowMidi + HIGH_NOTE_MIN_SEMITONES) {
      setTestInstruction("Detected pitch is too close to low note. Please sing higher and hold.");
      return;
    }
    highMidiRef.current = stableMidi;
    setRangeResult((prev) => ({ ...prev, highMidi: stableMidi }));
    finishRangeTest();
  };

  const handlePitchSampleForRangeTest = (timestamp: number, level: number, pitch: PitchData) => {
    const stage = stageRef.current;
    if (stage !== "capture_low" && stage !== "capture_high") {
      return;
    }
    if (stage === "capture_high" && waitForSilenceBeforeHighRef.current) {
      if (level < RMS_THRESHOLD * 0.6) {
        if (silenceStartRef.current === null) {
          silenceStartRef.current = timestamp;
        }
        if (timestamp - silenceStartRef.current >= SILENCE_RESET_MS) {
          waitForSilenceBeforeHighRef.current = false;
          silenceStartRef.current = null;
          setTestInstruction("Now sing your highest comfortable note and hold for 1 second.");
          setSampleState("idle");
        }
      } else {
        silenceStartRef.current = null;
        setTestInstruction("Pause briefly (near silence), then sing your highest note.");
      }
    }
    const hasFreq = typeof pitch.frequency_hz === "number" && pitch.frequency_hz > 0;
    const confidenceOk = pitch.confidence > CONFIDENCE_THRESHOLD || pitch.note_name !== null;
    const isValid = level > RMS_THRESHOLD && hasFreq && (confidenceOk || hasFreq);
    if (!isValid || pitch.frequency_hz === null) {
      fastPassRef.current = { stage: null, startAt: null };
      setSampleState("invalid");
      const stability = stableRef.current;
      if (stability.lastValidAt !== null && timestamp - stability.lastValidAt < 1200) {
        return;
      }
      resetStability();
      return;
    }
    if (pitch.confidence >= CONFIDENCE_PASS_THRESHOLD) {
      const fastPass = fastPassRef.current;
      if (fastPass.stage !== stage || fastPass.startAt === null) {
        fastPassRef.current = { stage, startAt: timestamp };
      } else if (timestamp - fastPass.startAt >= CONFIDENCE_PASS_MS) {
        completeStageWithMidi(stage, frequencyToMidi(pitch.frequency_hz), timestamp);
        return;
      }
    } else if (fastPassRef.current.stage === stage) {
      fastPassRef.current = { stage: null, startAt: null };
    }
    setSampleState("valid");
    const midi = frequencyToMidi(pitch.frequency_hz);
    const prevGood = lastGoodPitchRef.current;
    const smoothMidi = prevGood !== null && Math.abs(midi - prevGood) <= 4 ? prevGood * 0.65 + midi * 0.35 : midi;
    lastGoodPitchRef.current = smoothMidi;
    const stability = stableRef.current;
    if (stability.samples.length === 0) {
      stability.startAt = timestamp;
      stability.lastValidAt = timestamp;
      stability.samples = [smoothMidi];
      setStabilityMs(0);
      return;
    }
    const center = median(stability.samples);
    if (Math.abs(smoothMidi - center) > STABLE_NOTE_DELTA) {
      stability.startAt = timestamp;
      stability.lastValidAt = timestamp;
      stability.samples = [smoothMidi];
      setStabilityMs(0);
      return;
    }
    stability.lastValidAt = timestamp;
    stability.samples.push(smoothMidi);
    if (stability.samples.length > 20) {
      stability.samples.shift();
    }
    stableHistoryRef.current.push(smoothMidi);
    const elapsed = stability.startAt !== null ? timestamp - stability.startAt : 0;
    setStabilityMs(elapsed);
    if (elapsed >= STABLE_REQUIRED_MS) {
      const stableMidi = median(stability.samples);
      completeStageWithMidi(stage, stableMidi, timestamp);
    }
  };

  const stopLevelPolling = () => {
    if (pollTimerRef.current !== null) {
      window.clearInterval(pollTimerRef.current);
      pollTimerRef.current = null;
    }
    setInputLevel(0);
    setRawInputLevel(0);
    inputLevelRef.current = 0;
    rawInputLevelRef.current = 0;
    setPitchData({ frequency_hz: null, confidence: 0, note_name: null, cents_offset: null });
    pollErrorCountRef.current = 0;
    pollInFlightRef.current = false;
  };

  const startLevelPolling = () => {
    stopLevelPolling();
    pollTimerRef.current = window.setInterval(async () => {
      if (pollInFlightRef.current) return;
      pollInFlightRef.current = true;
      let hasAnySuccess = false;
      let sampledLevel = rawInputLevelRef.current;
      try {
        const level = await invoke<number>("get_input_level");
        const safeLevel = Number.isFinite(level) ? Math.max(0, Math.min(1, level)) : 0;
        const boostedLevel = Math.max(0, Math.min(1, safeLevel * LEVEL_GAIN));
        setRawInputLevel(safeLevel);
        rawInputLevelRef.current = safeLevel;
        setInputLevel(boostedLevel);
        inputLevelRef.current = boostedLevel;
        sampledLevel = safeLevel;
        hasAnySuccess = true;
      } catch { /* keep previous level */ }
      try {
        const pitch = await invoke<PitchData>("get_pitch_data");
        const safePitch: PitchData = {
          frequency_hz: typeof pitch.frequency_hz === "number" ? pitch.frequency_hz : null,
          confidence: Number.isFinite(pitch.confidence) ? Math.max(0, Math.min(1, pitch.confidence)) : 0,
          note_name: pitch.note_name ?? null,
          cents_offset: typeof pitch.cents_offset === "number" ? pitch.cents_offset : null
        };
        setPitchData(safePitch);
        hasAnySuccess = true;
        handlePitchSampleForRangeTest(Date.now(), sampledLevel, safePitch);
      } catch { /* keep previous pitch */ }
      if (hasAnySuccess) {
        pollErrorCountRef.current = 0;
      } else {
        pollErrorCountRef.current += 1;
      }
      if (pollErrorCountRef.current >= 20) {
        stopLevelPolling();
      }
      pollInFlightRef.current = false;
    }, 100);
  };

  useEffect(() => {
    return () => stopLevelPolling();
  }, []);

  const listInputDevices = async () => {
    const listedDevices = await invoke<InputDeviceInfo[]>("list_input_devices");
    setDevices(listedDevices);
    if (listedDevices.length === 0) {
      setSelectedDeviceId(null);
      localStorage.removeItem(SELECTED_DEVICE_KEY);
      setStatus("No input device found");
      return;
    }
    const currentDeviceId = selectedDeviceIdRef.current;
    const selectedStillExists = currentDeviceId ? listedDevices.some((d) => d.id === currentDeviceId) : false;
    const nextSelectedId = selectedStillExists && currentDeviceId ? currentDeviceId : listedDevices[0].id;
    setSelectedDeviceId(nextSelectedId);
    localStorage.setItem(SELECTED_DEVICE_KEY, nextSelectedId);
    setStatus(`Found ${listedDevices.length} input device(s)`);
  };

  useEffect(() => {
    if (activePage === "Home") {
      listInputDevices().catch((err) => {
        setStatus(`Failed to list devices: ${String(err)}`);
      });
    }
  }, [activePage]);

  const startStream = async (): Promise<boolean> => {
    try {
      await invoke("start_stream", { deviceId: selectedDeviceId });
      startLevelPolling();
      setStatus(`Audio input started`);
      return true;
    } catch (error) {
      stopLevelPolling();
      setStatus(`Failed to start audio input: ${String(error)}`);
      return false;
    }
  };

  const stopStream = async () => {
    try {
      await invoke("stop_stream");
      setStatus("Audio input stopped");
    } catch (error) {
      setStatus(`Failed to stop audio input: ${String(error)}`);
    } finally {
      stopLevelPolling();
    }
  };

  const resetTestFlow = async () => {
    await stopStream();
    resetRangeTest();
  };

  const startRangeTest = async () => {
    await invoke("stop_stream").catch(() => undefined);
    stopLevelPolling();
    const started = await startStream();
    if (!started) return;
    resetRangeTest();
    setTestStage("capture_low");
    stageRef.current = "capture_low";
    stageEnteredAtRef.current = Date.now();
    setAwaitingResultStep(false);
    setTestInstruction("Sing your lowest comfortable note and hold for 1 second.");
    setStatus("Range test started");
  };

  const goToResultStep = () => {
    if (rangeResult.lowMidi === null || rangeResult.highMidi === null) return;
    setAwaitingResultStep(false);
    setActivePage("Result");
  };

  const onSelectDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    localStorage.setItem(SELECTED_DEVICE_KEY, deviceId);
    const device = devices.find((item) => item.id === deviceId);
    if (device) setStatus(`Selected: ${device.name}`);
  };

  const loadRecommendations = async () => {
    const { lowMidi, highMidi, comfortLowMidi, comfortHighMidi } = rangeResult;
    try {
      let recs: SongRecommendation[] = [];
      const importedOnly = await invoke<SongRecommendation[]>("recommend_imported_songs");
      if (lowMidi !== null && highMidi !== null && comfortLowMidi !== null && comfortHighMidi !== null) {
        recs = await invoke<SongRecommendation[]>("recommend_songs", {
          userLowMidi: Math.round(lowMidi),
          userHighMidi: Math.round(highMidi),
          comfortLowMidi: Math.round(comfortLowMidi),
          comfortHighMidi: Math.round(comfortHighMidi)
        });
        if (recs.length === 0) {
          recs = await invoke<SongRecommendation[]>("recommend_songs", {
            userLowMidi: Math.round(lowMidi) - 4,
            userHighMidi: Math.round(highMidi) + 4,
            comfortLowMidi: Math.round(comfortLowMidi) - 2,
            comfortHighMidi: Math.round(comfortHighMidi) + 2
          });
          if (recs.length > 0) {
            setStatus("No strict matches. Showing closest challenge songs.");
          }
        }
      }
      const merged = [...recs];
      const seen = new Set(merged.map((s) => `${s.title}::${s.artist}`));
      for (const song of importedOnly) {
        const key = `${song.title}::${song.artist}`;
        if (!seen.has(key)) {
          seen.add(key);
          merged.push(song);
        }
      }
      setRecommendations(merged);
      setShowAllRecommendations(false);
    } catch (error) {
      setStatus(`Failed to load recommendations: ${String(error)}`);
      setRecommendations([]);
      setShowAllRecommendations(false);
    }
  };

  const checkPythonEnv = async () => {
    setPythonChecking(true);
    try {
      const status = await invoke<PythonEnvStatus>("check_python_env");
      setPythonEnv(status);
    } catch (error) {
      setPythonEnv({
        python_found: false, python_version: "", python_path: "",
        venv_exists: false, deps_installed: false,
        missing_deps: ["librosa", "numpy", "soundfile"],
        script_found: false, script_path: "", ready: false,
      });
    } finally {
      setPythonChecking(false);
    }
  };

  const setupPythonEnv = async () => {
    setPythonSetupBusy(true);
    setPythonSetupLogs([]);
    try {
      const results = await invoke<SetupProgress[]>("setup_python_env");
      setPythonSetupLogs(results);
      // Re-check after setup
      const status = await invoke<PythonEnvStatus>("check_python_env");
      setPythonEnv(status);
    } catch (error) {
      setPythonSetupLogs([{ step: "error", success: false, message: String(error) }]);
    } finally {
      setPythonSetupBusy(false);
    }
  };

  const importAudioFiles = async () => {
    const paths = await invoke<string[]>("pick_audio_files");
    if (paths.length === 0) return;
    setImportBusy(true);
    setImportFileCount(paths.length);
    setImportLogs([`Starting analysis for ${paths.length} file(s)...`]);
    setImportSummary("");
    try {
      const result = await invoke<ImportAnalyzeResponse>("import_and_analyze_songs", { filePaths: paths });
      const logs = result.logs ?? [];
      setImportLogs(logs.length > 0 ? logs : ["No analyzer logs"]);
      setImportSummary(
        `Added ${result.added} song(s), failed ${result.failed.length}.` +
          (result.output ? ` Output: ${result.output}` : "")
      );
      if (result.failed.length > 0) {
        setImportLogs((prev) => prev.concat(result.failed.map((f) => `FAILED: ${f}`)));
      }
    } catch (error) {
      setImportSummary("Import failed.");
      setImportLogs([String(error)]);
    } finally {
      setImportBusy(false);
    }
  };

  useEffect(() => {
    if (activePage === "Recommendations") {
      void loadRecommendations();
    }
  }, [activePage, rangeResult.lowMidi, rangeResult.highMidi, rangeResult.comfortLowMidi, rangeResult.comfortHighMidi]);

  useEffect(() => {
    if (activePage === "Song Library" && pythonEnv === null) {
      void checkPythonEnv();
    }
  }, [activePage]);

  // ==================== RENDER HELPERS ====================

  const holdProgress = Math.min(STABLE_REQUIRED_MS, stabilityMs);
  const holdPct = Math.round((holdProgress / STABLE_REQUIRED_MS) * 100);

  const ringClass = holdPct >= 100 ? "p100" : holdPct >= 75 ? "p75" : holdPct >= 50 ? "p50" : holdPct >= 25 ? "p25" : "p0";

  const isDetecting = sampleState === "valid" && (testStage === "capture_low" || testStage === "capture_high");

  const hasRange = rangeResult.lowMidi !== null && rangeResult.highMidi !== null;

  const navItems: { page: Page; label: string; icon: () => JSX.Element }[] = [
    { page: "Home", label: "Home", icon: HomeIcon },
    { page: "Test Live", label: "Test Live", icon: MicIcon },
    { page: "Result", label: "Result", icon: WaveIcon },
    { page: "Song Library", label: "Library", icon: MusicIcon },
    { page: "Recommendations", label: "For You", icon: StarIcon },
  ];

  // ==================== PAGE RENDERERS ====================

  const renderHome = () => (
    <>
      <div className="card">
        <div className="welcome-hero">
          <div className="welcome-icon"><MicIcon /></div>
          <h2>Welcome to MyPitch</h2>
          <p>Discover your vocal range and find songs that match your voice perfectly.</p>
          <button className="btn btn-primary" onClick={() => setActivePage("Test Live")}>
            <span className="btn-icon"><PlayIcon /></span>
            Start Range Test
          </button>
        </div>
      </div>

      <div className="card">
        <div className="card-header">
          <div>
            <div className="card-title">Microphone</div>
            <div className="card-subtitle">Select your input device</div>
          </div>
          <button className="btn btn-secondary btn-sm" onClick={listInputDevices}>Refresh</button>
        </div>
        <div className="device-selector">
          <div className="select-wrap">
            <select
              className="select-styled"
              value={selectedDeviceId ?? ""}
              onChange={(e) => onSelectDevice(e.target.value)}
              disabled={devices.length === 0}
              aria-label="Input device"
            >
              {devices.length === 0 ? (
                <option value="">No device found</option>
              ) : (
                devices.map((device) => (
                  <option key={device.id} value={device.id}>
                    {device.name} | {device.default_sample_rate ?? "n/a"} Hz | {device.channels ?? "n/a"} ch
                  </option>
                ))
              )}
            </select>
            <span className="select-arrow">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="6 9 12 15 18 9"/></svg>
            </span>
          </div>
        </div>
      </div>

      <div className="quick-actions">
        <div className="quick-card" onClick={() => setActivePage("Test Live")}>
          <div className="quick-card-icon"><MicIcon /></div>
          <h4>Range Test</h4>
          <p>Find your vocal range</p>
        </div>
        <div className="quick-card" onClick={() => setActivePage("Song Library")}>
          <div className="quick-card-icon"><UploadIcon /></div>
          <h4>Import Songs</h4>
          <p>Analyze your own music</p>
        </div>
      </div>
    </>
  );

  const renderTestLive = () => {
    const lowDone = rangeResult.lowMidi !== null;
    const highDone = rangeResult.highMidi !== null;

    return (
      <div className="card">
        {/* Stepper */}
        <div className="stepper">
          <div className={`step ${lowDone ? "done" : testStage === "capture_low" ? "active" : ""}`}>
            <div className="step-circle">{lowDone ? "\u2713" : "1"}</div>
            <span className="step-label">Low Note</span>
          </div>
          <div className={`step-line ${lowDone ? "done" : ""}`} />
          <div className={`step ${highDone ? "done" : testStage === "capture_high" ? "active" : ""}`}>
            <div className="step-circle">{highDone ? "\u2713" : "2"}</div>
            <span className="step-label">High Note</span>
          </div>
          <div className={`step-line ${highDone ? "done" : ""}`} />
          <div className={`step ${testStage === "done" ? "done" : awaitingResultStep ? "active" : ""}`}>
            <div className="step-circle">{testStage === "done" ? "\u2713" : "3"}</div>
            <span className="step-label">Result</span>
          </div>
        </div>

        {/* Note ring */}
        <div className="note-display">
          <div className="note-ring">
            <div className="note-ring-bg" />
            <div className={`note-ring-progress ${ringClass}`} />
            <span className={`note-value ${isDetecting ? "detecting" : ""}`}>
              {pitchData.note_name ?? "-"}
            </span>
          </div>
          <div className="note-freq">
            {pitchData.frequency_hz ? `${pitchData.frequency_hz.toFixed(2)} Hz` : "Waiting for input..."}
          </div>
        </div>

        <div className="instruction-text">{testInstruction}</div>

        {/* Level meter */}
        <div className="level-meter">
          <span className="level-label-sm">Input Level</span>
          <div className="level-bar">
            <div className="level-bar-fill" style={{ width: `${Math.round(inputLevel * 100)}%` }} />
          </div>
          <span className="level-pct">{(inputLevel * 100).toFixed(0)}%</span>
        </div>

        {/* Actions */}
        <div className="test-actions">
          <button className="btn btn-primary btn-sm" onClick={startRangeTest}>Start Test</button>
          <button className="btn btn-secondary btn-sm" onClick={stopStream}>Stop</button>
          <button className="btn btn-secondary btn-sm" onClick={resetTestFlow}>Reset</button>
          {awaitingResultStep && (
            <button className="btn btn-accent btn-sm" onClick={goToResultStep}>View Result</button>
          )}
        </div>

        {/* Debug toggle */}
        <div className="debug-toggle">
          <button onClick={() => setShowDebug((prev) => !prev)}>
            {showDebug ? "Hide technical details" : "Show technical details"}
          </button>
        </div>
        {showDebug && (
          <div className="debug-panel">
            <div className="debug-grid">
              <div className="debug-item">
                <div className="debug-label">RMS</div>
                <div className="debug-value">{rawInputLevel.toFixed(4)}</div>
              </div>
              <div className="debug-item">
                <div className="debug-label">Confidence</div>
                <div className="debug-value">{(pitchData.confidence * 100).toFixed(0)}%</div>
              </div>
              <div className="debug-item">
                <div className="debug-label">Hold</div>
                <div className="debug-value">{holdProgress}ms</div>
              </div>
              <div className="debug-item">
                <div className="debug-label">Stage</div>
                <div className="debug-value">
                  {testStage === "capture_low" ? "Low" : testStage === "capture_high" ? "High" : testStage === "done" ? "Done" : "Idle"}
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  const renderResult = () => {
    const { lowMidi, highMidi, comfortLowMidi, comfortHighMidi } = rangeResult;
    if (lowMidi === null || highMidi === null || comfortLowMidi === null || comfortHighMidi === null) {
      return (
        <div className="card">
          <div className="empty-state">
            <h3>No results yet</h3>
            <p>Complete a range test in Test Live to see your vocal range.</p>
            <button className="btn btn-primary" onClick={() => setActivePage("Test Live")} style={{ marginTop: 16 }}>
              Go to Test Live
            </button>
          </div>
        </div>
      );
    }

    const roundedLow = Math.round(lowMidi);
    const roundedHigh = Math.round(highMidi);
    const roundedComfortLow = Math.round(comfortLowMidi);
    const roundedComfortHigh = Math.round(comfortHighMidi);
    const semitones = roundedHigh - roundedLow;
    const octaves = (semitones / 12).toFixed(1);
    const voiceType = getVoiceType(lowMidi, highMidi);

    return (
      <>
        <div className="card">
          <div className="result-hero">
            <h2>Your Vocal Range</h2>
            <div className="result-range-text">
              {midiToNoteName(lowMidi)} &ndash; {midiToNoteName(highMidi)}
            </div>
            <div className="result-meta">About {octaves} octaves &middot; {semitones} semitones</div>
          </div>
        </div>

        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>Range Visualization</div>
          <div className="piano-wrap">
            <div className="piano">
              {PIANO_KEYS.map((key) => {
                let cls = "piano-key";
                if (key.isBlack) cls += " black";
                if (key.midi >= roundedComfortLow && key.midi <= roundedComfortHigh) {
                  cls += " comfort";
                } else if (key.midi >= roundedLow && key.midi <= roundedHigh) {
                  cls += " in-range";
                }
                return <div key={key.midi} className={cls}>{key.isBlack ? "" : key.name}</div>;
              })}
            </div>
          </div>
          <div className="piano-legend">
            <div className="legend-item"><div className="legend-swatch range" /> Full Range</div>
            <div className="legend-item"><div className="legend-swatch comfort" /> Comfort Zone</div>
          </div>
        </div>

        <div className="card">
          <div className="voice-type-card">
            <div className="voice-type-icon"><MicIcon /></div>
            <div className="voice-type-info">
              <h4>{voiceType.name}</h4>
              <p>{voiceType.description}</p>
            </div>
          </div>
          <div className="result-cta">
            <button className="btn btn-accent" onClick={() => setActivePage("Recommendations")}>
              <span className="btn-icon"><StarIcon /></span>
              Find Songs for My Voice
            </button>
          </div>
        </div>
      </>
    );
  };

  const renderPythonSetup = () => {
    if (pythonChecking) {
      return (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Checking Python Environment...</div>
          <p style={{ fontSize: 13, color: "var(--text-muted)" }}>Detecting Python installation and dependencies.</p>
        </div>
      );
    }

    if (!pythonEnv || pythonEnv.ready) return null;

    return (
      <div className="card" style={{ borderLeft: "4px solid var(--warning)" }}>
        <div className="card-title" style={{ marginBottom: 8 }}>Python Setup Required</div>
        <p style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 12 }}>
          Song analysis requires Python with audio processing libraries. {pythonEnv.python_found
            ? `Python ${pythonEnv.python_version} detected.`
            : "Python was not found on this computer."}
        </p>

        {!pythonEnv.python_found ? (
          <div style={{ background: "var(--warning-light)", borderRadius: "var(--radius-sm)", padding: "12px 16px", marginBottom: 12 }}>
            <p style={{ fontSize: 13, fontWeight: 600, color: "var(--warning)", marginBottom: 4 }}>Python not installed</p>
            <p style={{ fontSize: 12, color: "var(--text-secondary)" }}>
              Please install Python 3.10 or later from{" "}
              <strong>python.org</strong>, then restart MyPitch.
              Make sure to check "Add Python to PATH" during installation.
            </p>
          </div>
        ) : (
          <>
            {pythonEnv.missing_deps.length > 0 && (
              <div style={{ marginBottom: 12 }}>
                <p style={{ fontSize: 12, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>Missing dependencies:</p>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                  {pythonEnv.missing_deps.map((dep) => (
                    <span key={dep} style={{
                      padding: "3px 10px", borderRadius: 999, fontSize: 12, fontWeight: 600,
                      background: "var(--danger-light)", color: "var(--danger)",
                    }}>{dep}</span>
                  ))}
                </div>
              </div>
            )}
            <button
              className="btn btn-primary"
              onClick={setupPythonEnv}
              disabled={pythonSetupBusy}
              style={{ width: "100%" }}
            >
              {pythonSetupBusy ? "Setting up..." : "Install Dependencies Automatically"}
            </button>
            <p style={{ fontSize: 11, color: "var(--text-muted)", marginTop: 6, textAlign: "center" }}>
              This will create a virtual environment and install librosa, numpy, and soundfile.
            </p>
          </>
        )}

        {pythonSetupLogs.length > 0 && (
          <div style={{ marginTop: 12, padding: "10px 12px", background: "var(--surface-alt)", borderRadius: "var(--radius-sm)", border: "1px solid var(--border)" }}>
            {pythonSetupLogs.map((log, i) => (
              <div key={i} style={{ display: "flex", alignItems: "flex-start", gap: 8, padding: "4px 0", fontSize: 12 }}>
                <span style={{ flexShrink: 0 }}>{log.success ? "\u2705" : "\u274c"}</span>
                <span style={{ color: log.success ? "var(--success)" : "var(--danger)" }}>{log.message}</span>
              </div>
            ))}
          </div>
        )}

        <button
          className="btn btn-secondary btn-sm"
          onClick={checkPythonEnv}
          disabled={pythonChecking}
          style={{ marginTop: 8, width: "100%" }}
        >
          Re-check Environment
        </button>
      </div>
    );
  };

  const renderSongLibrary = () => (
    <>
      {renderPythonSetup()}

      <div className="card">
        <div className="drop-zone" onClick={importBusy || (pythonEnv && !pythonEnv.ready) ? undefined : importAudioFiles}
          style={(pythonEnv && !pythonEnv.ready) ? { opacity: 0.5, cursor: "not-allowed" } : {}}>
          <div className="drop-icon"><UploadIcon /></div>
          <h3>{importBusy ? "Analyzing..." : "Drop audio files here"}</h3>
          <p>{importBusy
            ? `Processing ${importFileCount} file(s)`
            : (pythonEnv && !pythonEnv.ready)
              ? "Set up Python above to enable song import"
              : "or click to browse \u00b7 Supports MP3, WAV"}</p>
        </div>
      </div>

      {importBusy && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 12 }}>Analysis Progress</div>
          <div className="progress-steps">
            <div className="progress-step done">1. Decode Audio</div>
            <div className="progress-step active">2. Pitch Tracking</div>
            <div className="progress-step">3. Save Results</div>
          </div>
          <div className="import-log">Processing {importFileCount} file(s)...</div>
        </div>
      )}

      {importSummary && (
        <div className="card">
          <div className="card-title" style={{ marginBottom: 8 }}>Import Result</div>
          <p style={{ fontSize: 14 }}>{importSummary}</p>
          {importLogs.length > 0 && (
            <div style={{ marginTop: 8 }}>
              {importLogs.map((log, i) => (
                <p key={i} className="import-log">{log}</p>
              ))}
            </div>
          )}
        </div>
      )}

      {pythonEnv?.ready && (
        <div className="card" style={{ borderLeft: "4px solid var(--success)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 16 }}>{"\u2705"}</span>
            <div>
              <div style={{ fontSize: 13, fontWeight: 600 }}>Python environment ready</div>
              <div style={{ fontSize: 11, color: "var(--text-muted)" }}>{pythonEnv.python_version} &bull; All dependencies installed</div>
              {!pythonEnv.script_found && (
                <div style={{ fontSize: 11, color: "var(--warning)", marginTop: 2 }}>
                  Analyzer script not found at: {pythonEnv.script_path}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </>
  );

  const renderRecommendations = () => {
    if (recommendations.length === 0) {
      return (
        <div className="card">
          <div className="empty-state">
            <h3>No recommendations found</h3>
            <p>Try running the test again with clearer low/high separation, or import songs to analyze.</p>
          </div>
        </div>
      );
    }

    const visibleRecommendations = showAllRecommendations
      ? recommendations
      : (() => {
          const top = recommendations.slice(0, 5);
          const seen = new Set(top.map((s) => `${s.title}::${s.artist}`));
          const imported = recommendations.filter((s) => {
            if (!s.is_imported) return false;
            const key = `${s.title}::${s.artist}`;
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return top.concat(imported);
        })();

    const filtered = recoFilter === "all"
      ? visibleRecommendations
      : visibleRecommendations.filter((s) => fitBucket(s.fit_score).className === recoFilter);

    return (
      <>
        <div className="filter-bar">
          {["all", "great", "singable", "challenging"].map((f) => (
            <button
              key={f}
              className={`filter-chip ${recoFilter === f ? "active" : ""}`}
              onClick={() => setRecoFilter(f)}
            >
              {f === "all" ? "All" : f === "great" ? "Great Fit" : f === "singable" ? "Singable" : "Challenging"}
            </button>
          ))}
        </div>

        <div className="reco-cards">
          {filtered.map((song, idx) => {
            const bucket = fitBucket(song.fit_score);
            const songKey = `${song.title}::${song.artist}`;
            const isExpanded = expandedSong === songKey;
            const reasons = buildFitReasons(song);
            const d = song.fit_detail;

            // Compute range comparison bar positions (normalized to piano range 36-71)
            const pianoSpan = 71 - 36;
            const yourLeft = hasRange ? ((Math.round(rangeResult.lowMidi!) - 36) / pianoSpan) * 100 : 0;
            const yourWidth = hasRange ? ((Math.round(rangeResult.highMidi!) - Math.round(rangeResult.lowMidi!)) / pianoSpan) * 100 : 0;
            const songLeft = ((song.shifted_low_midi - 36) / pianoSpan) * 100;
            const songWidth = ((song.shifted_high_midi - song.shifted_low_midi) / pianoSpan) * 100;

            return (
              <div
                key={songKey}
                className={`reco-card ${isExpanded ? "expanded" : ""}`}
                onClick={() => setExpandedSong(isExpanded ? null : songKey)}
              >
                <div className="reco-card-main">
                  <div className="reco-rank">{idx + 1}</div>
                  <div className="reco-info">
                    <div className="reco-song-title">{song.title}</div>
                    <div className="reco-artist">{song.artist}</div>
                  </div>
                </div>
                <div className="reco-shift">
                  {song.shift > 0 ? `+${song.shift}` : `${song.shift}`} st
                </div>
                <div className="reco-score">
                  <div className="score-bar-wrap">
                    <div className={`score-bar ${bucket.className}`} style={{ width: `${song.fit_score}%` }} />
                  </div>
                  <span className={`score-badge ${bucket.className}`}>
                    {song.fit_score} {bucket.label}
                  </span>
                </div>

                {isExpanded && (
                  <div className="reco-detail">
                    <div className="detail-grid">
                      <div className="detail-item">
                        <label>Melody Range (shifted)</label>
                        <span>{midiToNoteName(song.shifted_low_midi)} &ndash; {midiToNoteName(song.shifted_high_midi)}</span>
                      </div>
                      <div className="detail-item">
                        <label>Chorus Range (shifted)</label>
                        <span>{midiToNoteName(song.shifted_chorus_low_midi)} &ndash; {midiToNoteName(song.shifted_chorus_high_midi)}</span>
                      </div>
                      <div className="detail-item">
                        <label>Original Range</label>
                        <span>{midiToNoteName(song.original_low_midi)} &ndash; {midiToNoteName(song.original_high_midi)}</span>
                      </div>
                      <div className="detail-item">
                        <label>Key Shift</label>
                        <span>{song.is_original_key ? "Original key" : `${song.shift > 0 ? "+" : ""}${song.shift} semitones`}</span>
                      </div>
                    </div>

                    {/* Range comparison */}
                    {hasRange && (
                      <>
                        <div className="range-compare">
                          <span className="range-compare-label">Your range</span>
                          <div className="range-compare-bar">
                            <div className="range-compare-fill yours" style={{ left: `${Math.max(0, yourLeft)}%`, width: `${Math.max(2, yourWidth)}%` }} />
                          </div>
                        </div>
                        <div className="range-compare">
                          <span className="range-compare-label">Song range</span>
                          <div className="range-compare-bar">
                            <div className="range-compare-fill song" style={{ left: `${Math.max(0, songLeft)}%`, width: `${Math.max(2, songWidth)}%` }} />
                          </div>
                        </div>
                      </>
                    )}

                    <ul className="fit-reasons-list">
                      {reasons.map((r, i) => <li key={i}>{r}</li>)}
                    </ul>

                    {/* Tech details toggle */}
                    <button
                      className="btn btn-secondary btn-sm"
                      style={{ marginTop: 10 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowTechDetail(showTechDetail === songKey ? null : songKey);
                      }}
                    >
                      {showTechDetail === songKey ? "Hide penalties" : "Show penalty breakdown"}
                    </button>

                    {showTechDetail === songKey && (
                      <div className="tech-details">
                        <div className="penalty-grid">
                          <div className="penalty-item">
                            <div className="penalty-label">Shift</div>
                            <div className={`penalty-value ${d.shift_penalty <= 6 ? "ok" : d.shift_penalty <= 15 ? "warn" : "bad"}`}>
                              {d.shift_penalty.toFixed(1)}
                            </div>
                          </div>
                          <div className="penalty-item">
                            <div className="penalty-label">Range</div>
                            <div className={`penalty-value ${d.range_penalty <= 4 ? "ok" : d.range_penalty <= 12 ? "warn" : "bad"}`}>
                              {d.range_penalty.toFixed(1)}
                            </div>
                          </div>
                          <div className="penalty-item">
                            <div className="penalty-label">Chorus</div>
                            <div className={`penalty-value ${d.chorus_penalty <= 5 ? "ok" : d.chorus_penalty <= 12 ? "warn" : "bad"}`}>
                              {d.chorus_penalty.toFixed(1)}
                            </div>
                          </div>
                          <div className="penalty-item">
                            <div className="penalty-label">High Notes</div>
                            <div className={`penalty-value ${d.high_note_penalty <= 3 ? "ok" : d.high_note_penalty <= 8 ? "warn" : "bad"}`}>
                              {d.high_note_penalty.toFixed(1)}
                            </div>
                          </div>
                          <div className="penalty-item">
                            <div className="penalty-label">Low</div>
                            <div className={`penalty-value ${d.low_penalty <= 5 ? "ok" : "warn"}`}>
                              {d.low_penalty.toFixed(1)}
                            </div>
                          </div>
                          <div className="penalty-item">
                            <div className="penalty-label">Headroom</div>
                            <div className={`penalty-value ${d.headroom_comfort >= 0 ? "ok" : "warn"}`}>
                              {d.headroom_comfort >= 0 ? "+" : ""}{d.headroom_comfort}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}

          {recommendations.length > 5 && (
            <button
              className="show-all-btn"
              onClick={() => setShowAllRecommendations((prev) => !prev)}
            >
              {showAllRecommendations ? "Show Top 5" : `Show All (${recommendations.length})`}
            </button>
          )}
        </div>
      </>
    );
  };

  // ==================== MAIN RENDER ====================

  const isStreamActive = pollTimerRef.current !== null;

  return (
    <div className="app-shell">
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <div className="logo"><MicIcon /></div>
          <h1>MyPitch</h1>
        </div>
        {hasRange && (
          <div className="range-badge">
            <span className="range-badge-dot" />
            {midiToNoteName(rangeResult.lowMidi!)} &ndash; {midiToNoteName(rangeResult.highMidi!)}
          </div>
        )}
      </div>

      {/* Nav */}
      <nav className="tabs">
        {navItems.map(({ page, label, icon: Icon }) => (
          <button
            key={page}
            className={activePage === page ? "active" : ""}
            onClick={() => setActivePage(page)}
          >
            <span className="nav-icon"><Icon /></span>
            {label}
          </button>
        ))}
      </nav>

      {/* Page content */}
      {activePage === "Home" && renderHome()}
      {activePage === "Test Live" && renderTestLive()}
      {activePage === "Result" && renderResult()}
      {activePage === "Song Library" && renderSongLibrary()}
      {activePage === "Recommendations" && renderRecommendations()}

      {/* Status bar */}
      <div className="status-bar">
        <span className={`status-dot ${isStreamActive ? "active" : ""}`} />
        <span>{status}</span>
      </div>
    </div>
  );
}

export default App;

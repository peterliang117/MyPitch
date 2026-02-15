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

const pages: Page[] = ["Home", "Test Live", "Result", "Song Library", "Recommendations"];
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

function stageLabel(stage: TestStage): string {
  switch (stage) {
    case "capture_low":
      return "Capture Low Note";
    case "capture_high":
      return "Capture High Note";
    case "done":
      return "Completed";
    default:
      return "Not Started";
  }
}

function fitBucket(score: number): { label: string; className: string } {
  if (score >= 90) {
    return { label: "Great Fit", className: "fit-great" };
  }
  if (score >= 75) {
    return { label: "Singable", className: "fit-good" };
  }
  if (score >= 60) {
    return { label: "Challenging", className: "fit-mid" };
  }
  return { label: "Not Recommended", className: "fit-low" };
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
  const [selectedRecommendation, setSelectedRecommendation] = useState<SongRecommendation | null>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importLogs, setImportLogs] = useState<string[]>([]);
  const [importSummary, setImportSummary] = useState<string>("");
  const [importFileCount, setImportFileCount] = useState(0);
  const [showAllRecommendations, setShowAllRecommendations] = useState(false);

  const pollTimerRef = useRef<number | null>(null);
  const pollErrorCountRef = useRef(0);
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

  const resetStability = () => {
    stableRef.current = {
      startAt: null,
      lastValidAt: null,
      samples: []
    };
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
    setRangeResult({
      lowMidi: null,
      highMidi: null,
      comfortLowMidi: null,
      comfortHighMidi: null
    });
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

    setRangeResult({
      lowMidi,
      highMidi,
      comfortLowMidi: comfortLow,
      comfortHighMidi: comfortHigh
    });

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
          setTestInstruction("Now sing your highest comfortable 'ah' and hold for 1 second.");
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
    const smoothMidi =
      prevGood !== null && Math.abs(midi - prevGood) <= 4 ? prevGood * 0.65 + midi * 0.35 : midi;
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
    setPitchData({
      frequency_hz: null,
      confidence: 0,
      note_name: null,
      cents_offset: null
    });
    pollErrorCountRef.current = 0;
  };

  const startLevelPolling = () => {
    stopLevelPolling();
    pollTimerRef.current = window.setInterval(async () => {
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
      } catch {
        // Keep previous level on transient command failure.
      }

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
      } catch {
        // Keep previous pitch on transient command failure.
      }

      if (hasAnySuccess) {
        pollErrorCountRef.current = 0;
      } else {
        pollErrorCountRef.current += 1;
      }

      if (pollErrorCountRef.current >= 20) {
        stopLevelPolling();
      }
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

    const selectedStillExists = selectedDeviceId
      ? listedDevices.some((device) => device.id === selectedDeviceId)
      : false;

    const nextSelectedId: string =
      selectedStillExists && selectedDeviceId ? selectedDeviceId : listedDevices[0].id;
    setSelectedDeviceId(nextSelectedId);
    localStorage.setItem(SELECTED_DEVICE_KEY, nextSelectedId);
    setStatus(`Found ${listedDevices.length} input device(s)`);
  };

  useEffect(() => {
    if (activePage === "Home") {
      void listInputDevices();
    }
  }, [activePage]);

  const startStream = async (): Promise<boolean> => {
    try {
      await invoke("start_stream", { deviceId: selectedDeviceId });
      startLevelPolling();
      setStatus(`Audio input started (${selectedDeviceId ?? "default"})`);
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
    if (!started) {
      return;
    }

    resetRangeTest();
    setTestStage("capture_low");
    stageRef.current = "capture_low";
    stageEnteredAtRef.current = Date.now();
    setAwaitingResultStep(false);
    setTestInstruction("Sing your lowest comfortable 'ah' and hold for 1 second.");
    setStatus("Range test started");
  };

  const goToResultStep = () => {
    if (rangeResult.lowMidi === null || rangeResult.highMidi === null) {
      return;
    }
    setAwaitingResultStep(false);
    setActivePage("Result");
  };

  const onSelectDevice = (deviceId: string) => {
    setSelectedDeviceId(deviceId);
    localStorage.setItem(SELECTED_DEVICE_KEY, deviceId);
    const device = devices.find((item) => item.id === deviceId);
    if (device) {
      setStatus(`Selected: ${device.name}`);
    }
  };

  const renderResultScale = () => {
    const { lowMidi, highMidi, comfortLowMidi, comfortHighMidi } = rangeResult;
    if (lowMidi === null || highMidi === null || comfortLowMidi === null || comfortHighMidi === null) {
      return <p>No results yet. Complete a range test in Test Live.</p>;
    }

    const span = Math.max(1, highMidi - lowMidi);
    const comfortLeft = ((comfortLowMidi - lowMidi) / span) * 100;
    const comfortWidth = ((comfortHighMidi - comfortLowMidi) / span) * 100;

    return (
      <div className="result-block">
        <p>Lowest note: {midiToNoteName(lowMidi)} (MIDI {Math.round(lowMidi)})</p>
        <p>Highest note: {midiToNoteName(highMidi)} (MIDI {Math.round(highMidi)})</p>
        <p>
          Comfort range: {midiToNoteName(comfortLowMidi)} - {midiToNoteName(comfortHighMidi)}
        </p>
        <div className="range-track">
          <div
            className="range-comfort"
            style={{ left: `${Math.max(0, comfortLeft)}%`, width: `${Math.max(2, comfortWidth)}%` }}
          />
        </div>
      </div>
    );
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
      } else {
        recs = [];
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
      setSelectedRecommendation(merged.length > 0 ? merged[0] : null);
      setShowAllRecommendations(false);
    } catch (error) {
      setStatus(`Failed to load recommendations: ${String(error)}`);
      setRecommendations([]);
      setSelectedRecommendation(null);
      setShowAllRecommendations(false);
    }
  };

  const importAudioFiles = async () => {
    const paths = await invoke<string[]>("pick_audio_files");
    if (paths.length === 0) {
      return;
    }

    setImportBusy(true);
    setImportFileCount(paths.length);
    setImportLogs([`Starting analysis for ${paths.length} file(s)...`]);
    setImportSummary("");

    try {
      const result = await invoke<ImportAnalyzeResponse>("import_and_analyze_songs", {
        filePaths: paths
      });

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

  const renderPage = () => {
    if (activePage === "Home") {
      return (
        <>
          <div className="result-block">
            <p className="test-hint">Welcome to MyPitch</p>
            <p>Choose your microphone input device, then run Range Test in Test Live.</p>
          </div>
          <p>Input Device</p>
          <div className="actions">
            <button onClick={listInputDevices}>Refresh Devices</button>
          </div>
          <select
            id="input-device-select"
            value={selectedDeviceId ?? ""}
            onChange={(event) => onSelectDevice(event.target.value)}
            disabled={devices.length === 0}
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
        </>
      );
    }

    if (activePage === "Test Live") {
      const lowCaptured = rangeResult.lowMidi !== null;
      const highCaptured = rangeResult.highMidi !== null;
      const step1Done = lowCaptured;
      const step2Done = highCaptured;
      const step3Active = awaitingResultStep;
      const step3Done = false;
      const holdProgress = Math.round((Math.min(STABLE_REQUIRED_MS, stabilityMs) / STABLE_REQUIRED_MS) * 100);
      const liveClass = sampleState === "valid" ? "state-valid" : sampleState === "invalid" ? "state-invalid" : "";

      return (
        <>
          <div className="flow-steps" aria-label="Range test steps">
            <div className={`flow-step ${liveClass} ${step1Done ? "done" : ""} ${testStage === "capture_low" ? "active" : ""}`}>
              <span>1</span>
              <p>Hold Low Note</p>
            </div>
            <div className={`flow-step ${liveClass} ${step2Done ? "done" : ""} ${testStage === "capture_high" ? "active" : ""}`}>
              <span>2</span>
              <p>Hold High Note</p>
            </div>
            <div className={`flow-step ${liveClass} ${step3Done ? "done" : ""} ${step3Active ? "active" : ""}`}>
              <span>3</span>
              <p>View Result</p>
            </div>
          </div>

          <div className="result-block">
            <p className="test-hint">{testInstruction}</p>
            <p>
              Valid sample rule: confidence &gt; {CONFIDENCE_THRESHOLD}, RMS &gt; {RMS_THRESHOLD}, stable for at least {STABLE_REQUIRED_MS} ms
            </p>
            <p>Raw RMS: {rawInputLevel.toFixed(4)}</p>
            <p>Hold steady progress: {Math.min(STABLE_REQUIRED_MS, stabilityMs)} / {STABLE_REQUIRED_MS} ms</p>
            <div className="hold-track">
              <div className="hold-fill" style={{ width: `${holdProgress}%` }} />
            </div>
            <div className="actions">
              <button onClick={startRangeTest}>Start Range Test</button>
              <button onClick={stopStream}>Stop Audio</button>
              <button onClick={resetTestFlow}>Reset Test</button>
              {awaitingResultStep && (
                <button onClick={goToResultStep}>Next Step: View Result</button>
              )}
            </div>
          </div>

          <div className="pitch-grid">
            <div className="pitch-card">
              <p className="pitch-label">Stage</p>
              <p className="pitch-value">{stageLabel(testStage)}</p>
            </div>
            <div className="pitch-card">
              <p className="pitch-label">Note</p>
              <p className="pitch-value">{pitchData.note_name ?? "-"}</p>
            </div>
            <div className="pitch-card">
              <p className="pitch-label">Frequency</p>
              <p className="pitch-value">
                {pitchData.frequency_hz ? `${pitchData.frequency_hz.toFixed(2)} Hz` : "-"}
              </p>
            </div>
            <div className="pitch-card">
              <p className="pitch-label">Confidence</p>
              <p className="pitch-value">{(pitchData.confidence * 100).toFixed(0)}%</p>
            </div>
          </div>
        </>
      );
    }

    if (activePage === "Result") {
      return renderResultScale();
    }

    if (activePage === "Song Library") {
      return (
        <div className="result-block">
          <p className="test-hint">Import Audio Files</p>
          <p>Select one or more mp3/wav files. The app runs local analysis and updates generated song metadata.</p>
          {importBusy && (
            <div className="analyze-visual">
              <p className="analyze-title">
                Analyzing {importFileCount} file(s)
                <span className="dot dot-1">.</span>
                <span className="dot dot-2">.</span>
                <span className="dot dot-3">.</span>
              </p>
              <div className="analyze-track">
                <div className="analyze-fill" />
              </div>
              <div className="analyze-steps">
                <span>1) Decode audio</span>
                <span>2) Pitch tracking (pyin)</span>
                <span>3) Write songs_generated.csv</span>
              </div>
            </div>
          )}
          <div className="actions">
            <button onClick={importAudioFiles} disabled={importBusy}>
              {importBusy ? "Analyzing..." : "Import Audio"}
            </button>
          </div>
          {importSummary && <p>{importSummary}</p>}
          {importLogs.length > 0 && (
            <div className="fit-reasons">
              {importLogs.map((log) => (
                <p key={log}>{log}</p>
              ))}
            </div>
          )}
        </div>
      );
    }

    if (activePage === "Recommendations") {
      if (recommendations.length === 0) {
        return (
          <div className="result-block">
            <p className="test-hint">No recommendation found for current detected range.</p>
            <p>
              Try running the test again with clearer low/high separation, or sing a little louder so confidence and
              range capture are more stable.
            </p>
          </div>
        );
      }

      const visibleRecommendations = showAllRecommendations
        ? recommendations
        : (() => {
            const top = recommendations.slice(0, 5);
            const seen = new Set(top.map((s) => `${s.title}::${s.artist}`));
            const imported = recommendations.filter((s) => {
              if (!s.is_imported) {
                return false;
              }
              const key = `${s.title}::${s.artist}`;
              if (seen.has(key)) {
                return false;
              }
              seen.add(key);
              return true;
            });
            return top.concat(imported);
          })();

      return (
        <div className="reco-grid">
          <div className="reco-list">
            {visibleRecommendations.map((song) => (
              (() => {
                const bucket = fitBucket(song.fit_score);
                return (
              <button
                key={`${song.title}-${song.artist}`}
                className={`reco-item ${selectedRecommendation?.title === song.title && selectedRecommendation?.artist === song.artist ? "active" : ""}`}
                onClick={() => setSelectedRecommendation(song)}
              >
                <span className="reco-title">{song.title}</span>
                <span>{song.artist}</span>
                <span>{song.shift > 0 ? `+${song.shift}` : `${song.shift}`} st</span>
                <span className={`fit-badge ${bucket.className}`}>{song.fit_score}</span>
                <div className="fit-meter">
                  <div className={`fit-meter-fill ${bucket.className}`} style={{ width: `${song.fit_score}%` }} />
                </div>
              </button>
                );
              })()
            ))}
            {recommendations.length > 5 && (
              <button
                className="reco-item"
                onClick={() => setShowAllRecommendations((prev) => !prev)}
              >
                <span className="reco-title">
                  {showAllRecommendations ? "Show Top 5" : `Show All (${recommendations.length})`}
                </span>
                <span />
                <span />
                <span />
              </button>
            )}
          </div>

          {selectedRecommendation && (
            <div className="result-block">
              {(() => {
                const bucket = fitBucket(selectedRecommendation.fit_score);
                const reasons = buildFitReasons(selectedRecommendation);
                return (
                  <>
              <p className="test-hint">{selectedRecommendation.title}</p>
              <p>Artist: {selectedRecommendation.artist}</p>
              <p>Recommended Shift: {selectedRecommendation.shift > 0 ? `+${selectedRecommendation.shift}` : selectedRecommendation.shift} semitones</p>
              <p>
                Fit Score: <span className={`fit-badge ${bucket.className}`}>{selectedRecommendation.fit_score}</span> ({bucket.label})
              </p>
              <p>
                Melody Range (shifted): {midiToNoteName(selectedRecommendation.shifted_low_midi)} - {midiToNoteName(selectedRecommendation.shifted_high_midi)}
              </p>
              <p>
                Chorus Range (shifted): {midiToNoteName(selectedRecommendation.shifted_chorus_low_midi)} - {midiToNoteName(selectedRecommendation.shifted_chorus_high_midi)}
              </p>
              <p>
                Original Range: {midiToNoteName(selectedRecommendation.original_low_midi)} - {midiToNoteName(selectedRecommendation.original_high_midi)}
              </p>
              <p>
                Original Chorus: {midiToNoteName(selectedRecommendation.original_chorus_low_midi)} - {midiToNoteName(selectedRecommendation.original_chorus_high_midi)}
              </p>
              <p>Original Key: {selectedRecommendation.is_original_key ? "Yes" : "No"}</p>
              <div className="fit-detail-grid">
                <p>shift penalty: {selectedRecommendation.fit_detail.shift_penalty.toFixed(1)}</p>
                <p>range penalty: {selectedRecommendation.fit_detail.range_penalty.toFixed(1)}</p>
                <p>chorus penalty: {selectedRecommendation.fit_detail.chorus_penalty.toFixed(1)}</p>
                <p>high note penalty: {selectedRecommendation.fit_detail.high_note_penalty.toFixed(1)}</p>
                <p>low penalty: {selectedRecommendation.fit_detail.low_penalty.toFixed(1)}</p>
                <p>comfort headroom: {selectedRecommendation.fit_detail.headroom_comfort}</p>
              </div>
              <div className="fit-reasons">
                {reasons.map((reason) => (
                  <p key={reason}>{reason}</p>
                ))}
              </div>
                  </>
                );
              })()}
            </div>
          )}
        </div>
      );
    }

    return <p>Page unavailable.</p>;
  };

  return (
    <div className="app-shell">
      <header>
        <h1>MyPitch</h1>
      </header>

      <nav className="tabs">
        {pages.map((page) => (
          <button
            key={page}
            className={activePage === page ? "active" : ""}
            onClick={() => setActivePage(page)}
          >
            {page}
          </button>
        ))}
      </nav>

      <main className="card">
        <h2>{activePage}</h2>
        {renderPage()}

        {activePage === "Test Live" && (
          <div className="level-wrap">
            <p className="level-label">Input Level: {(inputLevel * 100).toFixed(0)}%</p>
            <div className="level-track">
              <div className="level-fill" style={{ width: `${Math.round(inputLevel * 100)}%` }} />
            </div>
          </div>
        )}

        {activePage !== "Home" && <p className="status">{status}</p>}
      </main>
    </div>
  );
}

export default App;

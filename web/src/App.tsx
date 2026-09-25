import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { MicVAD } from "@ricky0123/vad-web";
import { removeAssistantEcho } from "./assistant-echo";
import { isCurrentVoiceSession, SerializedVadTransitions, VoiceInputCoordinator } from "./input-coordinator";
import { LiveTranscription } from "./live-transcription";
import { BargeInGuard } from "./barge-in-guard";
import { prepareAudioBuffer } from "./audio-playback";
import { SpeechPipeline, type PreparedSpeech } from "./speech-pipeline";
import { vadOptions } from "./vad-config";
import { consumeSpeechChunks, hasActiveVoiceTurn, samplesWav } from "./voice";
import { acquireVoiceOwnership, type VoiceOwnership } from "./voice-ownership";
import { clearVoicePreference, readVoicePreference, writeVoicePreference } from "./voice-preference";
import { uid } from "./uid";
import { authHeaders, checkAuthorized, UnauthorizedError } from "./auth";
import { UnauthorizedScreen } from "./UnauthorizedScreen";
import { harnessLabel, type HarnessId, type SessionsResponse, type TurnEvent } from "./session-types";

interface AppProps {
  sessionKey: string;
}

type SessionDisplay = { harness?: HarnessId; title: string; cwd: string };

function deriveSessionDisplay(key: string): SessionDisplay {
  if (key.startsWith("new:")) return { harness: key.slice(4) as HarnessId, title: "New chat", cwd: "~" };
  if (key === "quick") return { title: "Quick chat", cwd: "~" };
  const separator = key.indexOf(":");
  if (separator === -1) return { title: key, cwd: "" };
  return { harness: key.slice(0, separator) as HarnessId, title: key.slice(separator + 1), cwd: "" };
}

function conversationStorageKey(sessionKey: string): string {
  return `meldivo.conversation.${sessionKey}`;
}

function getConversationId(sessionKey: string): string {
  const key = conversationStorageKey(sessionKey);
  try {
    const existing = window.sessionStorage.getItem(key);
    if (existing) return existing;
    const created = uid();
    window.sessionStorage.setItem(key, created);
    return created;
  } catch {
    return uid();
  }
}

type VoiceState = "idle" | "listening" | "hearing" | "thinking" | "running" | "speaking" | "muted" | "error";
const acceptedSpeechWatchdogMs = 12_000;
const longPressMs = 560;
const previewText = "This is a voice preview.";
const onboardingDismissedKey = "voice-assistant.onboarding-dismissed";
const healthPollMs = 3_000;

type ContextMenuPosition = { x: number; y: number };
type VoiceListResponse = { current?: unknown; voices?: unknown; available?: unknown; warning?: unknown };
type SpeechHealth = { ready: boolean; downloading: boolean; progress?: number; error?: string };
type HealthResponse = { ok?: unknown; speech?: { ready?: unknown; downloading?: unknown; progress?: unknown; error?: unknown } };

function friendlyLabel(value: string): string {
  const kokoroVoice = /^([a-z]{2})[_-](.+)$/i.exec(value);
  const kokoroPrefix: Record<string, string> = {
    af: "American female", am: "American male", bf: "British female", bm: "British male",
    ef: "Spanish female", em: "Spanish male", ff: "French female", fm: "French male",
    hf: "Hindi female", hm: "Hindi male", if: "Italian female", im: "Italian male",
    jf: "Japanese female", jm: "Japanese male", pf: "Portuguese female", pm: "Portuguese male",
    zf: "Chinese female", zm: "Chinese male",
  };
  if (kokoroVoice) {
    const locale = kokoroPrefix[kokoroVoice[1].toLowerCase()];
    if (locale) return `${friendlyLabel(kokoroVoice[2])} — ${locale}`;
  }
  return value
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function shouldShowOnboarding(): boolean {
  try {
    return window.localStorage.getItem(onboardingDismissedKey) !== "true";
  } catch {
    return true;
  }
}

class VoiceOwnershipError extends Error {
  constructor() {
    super("Another voice tab is active. Close it or stop voice there first.");
    this.name = "VoiceOwnershipError";
  }
}

async function streamTurnEvents(response: Response, onEvent: (event: TurnEvent) => void) {
  if (!response.body) throw new Error("Chat response was empty.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let pending = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    pending += value;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (!data) continue;
      let event: TurnEvent;
      try { event = JSON.parse(data) as TurnEvent; } catch { continue; }
      onEvent(event);
      if (event.type === "done") return;
    }
  }
}

export default function App({ sessionKey }: AppProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const stateRef = useRef(state);
  const mounted = useRef(true);
  const muted = useRef(false);
  const started = useRef(false);
  const starting = useRef(false);
  const speaking = useRef(false);
  const vad = useRef<MicVAD | null>(null);
  const stream = useRef<MediaStream | null>(null);
  const audio = useRef<AudioContext | null>(null);
  const outputGain = useRef<GainNode | null>(null);
  const chat = useRef<AbortController | null>(null);
  const harnessTurnActive = useRef(false);
  const pipeline = useRef<SpeechPipeline | null>(null);
  const transcription = useRef<LiveTranscription | null>(null);
  const input = useRef<VoiceInputCoordinator | null>(null);
  const vadTransitions = useRef(new SerializedVadTransitions());
  const sessionEpoch = useRef(0);
  const startupGeneration = useRef(0);
  const acceptedWatchdog = useRef<number | null>(null);
  const errorTimer = useRef<number | null>(null);
  const errorToken = useRef(0);
  const conversationId = useRef(getConversationId(sessionKey));
  const liveKey = useRef(sessionKey);
  const harnessRef = useRef<HarnessId | undefined>(deriveSessionDisplay(sessionKey).harness);
  const generation = useRef(0);
  const outputFrame = useRef(0);
  const meterOwner = useRef<symbol | null>(null);
  const assistantAudio = useRef("");
  const echoReference = useRef("");
  const ownership = useRef<VoiceOwnership | null>(null);
  const bargeIn = useRef(new BargeInGuard());
  const turnVoice = useRef<string>();
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceList, setVoiceList] = useState<string[]>([]);
  const [profileVoice, setProfileVoice] = useState("");
  const [selectedVoice, setSelectedVoice] = useState(() => readVoicePreference() ?? "");
  const [savedVoice, setSavedVoice] = useState(() => readVoicePreference() ?? "");
  const [speechHealth, setSpeechHealth] = useState<SpeechHealth>({ ready: true, downloading: false });
  const [sessionDisplay, setSessionDisplay] = useState<SessionDisplay>(() => deriveSessionDisplay(sessionKey));
  const [unauthorized, setUnauthorized] = useState(false);
  const [statusText, setStatusText] = useState("");
  const [voiceCatalogWarning, setVoiceCatalogWarning] = useState("");
  const [voiceLoading, setVoiceLoading] = useState(false);
  const [voiceError, setVoiceError] = useState("");
  const [voiceNotice, setVoiceNotice] = useState("");
  const [previewVoice, setPreviewVoice] = useState<string | null>(null);
  const [onboardingOpen, setOnboardingOpen] = useState(shouldShowOnboarding);
  const longPressTimer = useRef<number | null>(null);
  const longPressStart = useRef<{ pointerId: number; x: number; y: number } | null>(null);
  const suppressClickUntil = useRef(0);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const voiceSelectRef = useRef<HTMLSelectElement | null>(null);
  const voicesRequest = useRef<AbortController | null>(null);
  const previewRequest = useRef<AbortController | null>(null);
  const previewContext = useRef<AudioContext | null>(null);
  const previewPlayback = useRef<PreparedSpeech | null>(null);
  const settingsOpenRef = useRef(false);
  const settingsMicPaused = useRef(false);

  const clearAcceptedWatchdog = () => {
    if (acceptedWatchdog.current !== null) window.clearTimeout(acceptedWatchdog.current);
    acceptedWatchdog.current = null;
  };

  const updateState = (next: VoiceState) => {
    stateRef.current = next;
    if (mounted.current) setState(next);
  };
  const stopMeter = (owner?: symbol) => {
    if (owner && meterOwner.current !== owner) return;
    cancelAnimationFrame(outputFrame.current);
    meterOwner.current = null;
    speaking.current = false;
    if (mounted.current) setLevel(0);
  };
  const startMeter = (analyser: AnalyserNode, owner: symbol) => {
    cancelAnimationFrame(outputFrame.current);
    meterOwner.current = owner;
    speaking.current = true;
    updateState("speaking");
    const values = new Float32Array(analyser.fftSize);
    const meter = () => {
      if (meterOwner.current !== owner) return;
      analyser.getFloatTimeDomainData(values);
      setLevel(Math.min(1, Math.sqrt(values.reduce((total, value) => total + value * value, 0) / values.length) * 6));
      outputFrame.current = requestAnimationFrame(meter);
    };
    meter();
  };
  const syncState = () => {
    if (muted.current || stateRef.current === "error") return;
    if (speaking.current) updateState("speaking");
    else if (pipeline.current?.busy && stateRef.current === "speaking") updateState("speaking");
    else if (chat.current || pipeline.current?.busy || input.current?.busy) updateState(harnessTurnActive.current ? "running" : "thinking");
    else if (started.current) updateState("listening");
  };
  const duckOutput = () => {
    const gain = outputGain.current;
    const context = audio.current;
    if (!gain || !context) return;
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(0.01, context.currentTime, 0.015);
  };
  const restoreOutput = () => {
    const gain = outputGain.current;
    const context = audio.current;
    if (!gain || !context) return;
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(1, context.currentTime, 0.015);
  };
  const report = (message: string) => {
    if (!mounted.current) return;
    const token = ++errorToken.current;
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    setError(message);
    updateState("error");
    errorTimer.current = window.setTimeout(() => {
      if (errorToken.current !== token) return;
      errorTimer.current = null;
      setError("");
      if (stateRef.current === "error") updateState(started.current ? (muted.current ? "muted" : "listening") : "idle");
    }, 4_000);
  };
  const releaseOwnership = () => {
    ownership.current?.release();
    ownership.current = null;
  };
  const abortTurn = () => {
    generation.current++;
    const wasActive = harnessTurnActive.current || Boolean(chat.current);
    harnessTurnActive.current = false;
    chat.current?.abort();
    chat.current = null;
    pipeline.current?.cancel();
    stopMeter();
    if (wasActive) {
      void fetch(`/api/sessions/${encodeURIComponent(liveKey.current)}/cancel`, {
        method: "POST", headers: authHeaders(),
      }).catch(() => undefined);
    }
    if (!muted.current && started.current) updateState("listening");
  };
  const interruptActiveTurn = () => {
    if (hasActiveVoiceTurn(Boolean(chat.current), Boolean(pipeline.current?.busy), speaking.current)) abortTurn();
  };
  const deactivateVoice = (message: string) => {
    if (!started.current && !starting.current) return;
    started.current = false;
    starting.current = false;
    settingsMicPaused.current = false;
    sessionEpoch.current++;
    clearAcceptedWatchdog();
    vadTransitions.current.deactivate();
    muted.current = false;
    abortTurn();
    restoreOutput();
    bargeIn.current.reset();
    transcription.current?.reset();
    transcription.current = null;
    input.current?.reset();
    input.current = null;
    pipeline.current = null;
    const detector = vad.current;
    vad.current = null;
    void detector?.destroy().catch(() => undefined);
    const microphone = stream.current;
    stream.current = null;
    microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    const context = audio.current;
    audio.current = null;
    outputGain.current?.disconnect();
    outputGain.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    releaseOwnership();
    report(message);
  };
  const handleOwnershipLost = () => {
    if (!started.current) return;
    started.current = false;
    settingsMicPaused.current = false;
    sessionEpoch.current++;
    clearAcceptedWatchdog();
    vadTransitions.current.deactivate();
    muted.current = false;
    abortTurn();
    restoreOutput();
    bargeIn.current.reset();
    transcription.current?.reset();
    transcription.current = null;
    input.current?.reset();
    input.current = null;
    pipeline.current = null;
    const detector = vad.current;
    vad.current = null;
    void detector?.destroy().catch(() => undefined);
    const microphone = stream.current;
    stream.current = null;
    microphone?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    const context = audio.current;
    audio.current = null;
    outputGain.current?.disconnect();
    outputGain.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    releaseOwnership();
    report("Voice session moved to another tab. Tap the shape to reconnect.");
  };

  const transcribe = async (samples: Float32Array, signal: AbortSignal) => {
    const response = await fetch("/api/voice/transcribe", {
      method: "POST", headers: { "Content-Type": "audio/wav", ...authHeaders() }, body: samplesWav(samples), signal,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error ?? "Transcription failed.");
    return String(result.text ?? "").trim();
  };

  const synthesize = async (text: string, signal: AbortSignal): Promise<PreparedSpeech> => {
    const context = audio.current;
    if (!context) throw new Error("Audio output is not ready.");
    const playback = Symbol("playback");
    const playbackStarted = (analyser: AnalyserNode) => {
      assistantAudio.current = text.trim();
      startMeter(analyser, playback);
    };
    const response = await fetch("/api/voice/speech", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/wav", ...authHeaders() },
      body: JSON.stringify({
        text,
        ...(turnVoice.current ? { voice: turnVoice.current } : {}),
      }), signal,
    });
    if (response.headers.get("x-voice-fallback") === "configured") {
      turnVoice.current = undefined;
      clearVoicePreference();
    }
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Speech generation failed.");
    const bytes = await response.arrayBuffer();
    signal.throwIfAborted();
    const buffer = await context.decodeAudioData(bytes);
    signal.throwIfAborted();
    const prepared = prepareAudioBuffer(
      buffer,
      context,
      outputGain.current ?? context.destination,
      playbackStarted,
    );
    const play = (async (playbackSignal: AbortSignal) => {
      try { await prepared(playbackSignal); }
      finally { stopMeter(playback); syncState(); }
    }) as PreparedSpeech;
    play.completed = prepared.completed;
    return play;
  };

  const closeMenus = () => {
    setContextMenu(null);
    setSettingsOpen(false);
  };

  const openContextMenu = (x: number, y: number) => {
    setContextMenu({ x, y });
    setSettingsOpen(false);
  };

  const clearLongPress = () => {
    if (longPressTimer.current !== null) window.clearTimeout(longPressTimer.current);
    longPressTimer.current = null;
    longPressStart.current = null;
  };

  const handlePointerDown = (event: ReactPointerEvent<HTMLButtonElement>) => {
    if (contextMenu || settingsOpen) {
      suppressClickUntil.current = Date.now() + 1_000;
      clearLongPress();
      return;
    }
    if (event.pointerType !== "touch") return;
    clearLongPress();
    const { clientX: x, clientY: y, pointerId } = event;
    longPressStart.current = { pointerId, x, y };
    longPressTimer.current = window.setTimeout(() => {
      longPressTimer.current = null;
      longPressStart.current = null;
      suppressClickUntil.current = Date.now() + 1_000;
      openContextMenu(x, y);
    }, longPressMs);
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const start = longPressStart.current;
    if (!start || start.pointerId !== event.pointerId) return;
    if (Math.hypot(event.clientX - start.x, event.clientY - start.y) > 10) clearLongPress();
  };

  const stopPreview = () => {
    previewRequest.current?.abort();
    previewRequest.current = null;
    previewPlayback.current = null;
    const context = previewContext.current;
    previewContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
    setPreviewVoice(null);
  };

  const playPreview = async () => {
    if (!selectedVoice || previewVoice) return;
    stopPreview();
    const controller = new AbortController();
    previewRequest.current = controller;
    const context = new AudioContext();
    previewContext.current = context;
    setVoiceError("");
    setPreviewVoice(selectedVoice);
    try {
      await context.resume();
      const response = await fetch("/api/voice/speech", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "audio/wav", ...authHeaders() },
        body: JSON.stringify({ text: previewText, voice: selectedVoice }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Voice preview failed.");
      const bytes = await response.arrayBuffer();
      controller.signal.throwIfAborted();
      const buffer = await context.decodeAudioData(bytes);
      controller.signal.throwIfAborted();
      const prepared = prepareAudioBuffer(buffer, context, context.destination, () => {});
      if (previewRequest.current !== controller) return;
      previewPlayback.current = prepared;
      await prepared(controller.signal);
    } catch (caught) {
      if (!(caught instanceof DOMException && caught.name === "AbortError") && previewRequest.current === controller) {
        setVoiceError(caught instanceof Error ? caught.message : "Voice preview failed.");
      }
    } finally {
      if (previewRequest.current === controller) previewRequest.current = null;
      previewPlayback.current = null;
      if (previewContext.current === context) {
        previewContext.current = null;
        if (context.state !== "closed") void context.close().catch(() => undefined);
      }
      if (previewRequest.current === null) setPreviewVoice(null);
    }
  };

  const loadVoiceList = (preferredVoice?: string) => {
    voicesRequest.current?.abort();
    const controller = new AbortController();
    voicesRequest.current = controller;
    setVoiceLoading(true);
    setVoiceError("");
    setVoiceCatalogWarning("");
    void fetch("/api/voice/voices", { headers: authHeaders(), signal: controller.signal })
      .then(async (response) => {
        const result = await response.json() as VoiceListResponse;
        if (!response.ok) throw new Error(typeof result.current === "string" ? result.current : "Could not load voices.");
        const voices = Array.isArray(result.voices)
          ? result.voices.filter((voice): voice is string => typeof voice === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(voice))
          : [];
        const current = typeof result.current === "string" && /^[A-Za-z0-9._-]{1,100}$/.test(result.current) ? result.current : "";
        if (voicesRequest.current !== controller || controller.signal.aborted) return;
        const stored = preferredVoice ?? readVoicePreference();
        const nextSaved = stored && (!voices.length || voices.includes(stored)) ? stored : "";
        setVoiceList(voices);
        setProfileVoice(current);
        setSavedVoice(nextSaved);
        setSelectedVoice(nextSaved || current || voices[0] || "");
        setVoiceCatalogWarning(result.available === false && typeof result.warning === "string" ? result.warning : "");
      })
      .catch((caught) => {
        if (!(caught instanceof DOMException && caught.name === "AbortError") && !controller.signal.aborted) {
          setVoiceError(caught instanceof Error ? caught.message : "Could not load voices.");
        }
      })
      .finally(() => {
        if (voicesRequest.current === controller) {
          voicesRequest.current = null;
          setVoiceLoading(false);
        }
      });
  };

  const applyVoice = () => {
    if (!selectedVoice) return;
    if (!writeVoicePreference(selectedVoice)) {
      setVoiceError("This voice could not be saved.");
      return;
    }
    setSavedVoice(selectedVoice);
    setVoiceError("");
    setVoiceNotice(`${friendlyLabel(selectedVoice)} will be used from the next reply.`);
  };

  const resetVoice = () => {
    clearVoicePreference();
    setSavedVoice("");
    setSelectedVoice(profileVoice);
    setVoiceError("");
    setVoiceNotice(`${profileVoice ? friendlyLabel(profileVoice) : "The profile default"} will be used from the next reply.`);
  };

  const pauseMicrophoneForSettings = async () => {
    if (!started.current || muted.current || settingsMicPaused.current) return;
    const detector = vad.current;
    if (!detector) return;
    settingsMicPaused.current = true;
    clearAcceptedWatchdog();
    bargeIn.current.reset();
    echoReference.current = "";
    transcription.current?.reset();
    input.current?.reset();
    restoreOutput();
    detector.setOptions({ submitUserSpeechOnPause: false });
    try {
      await vadTransitions.current.pause(detector);
      if (vad.current !== detector || !started.current || muted.current || !settingsOpenRef.current) {
        settingsMicPaused.current = false;
      }
    } catch (caught) {
      settingsMicPaused.current = false;
      if (vad.current !== detector || !started.current || muted.current) return;
      detector.setOptions({ submitUserSpeechOnPause: true });
      deactivateVoice(vadTransitions.current.isInvalid(detector)
        ? "Microphone transition timed out. Tap the shape to reconnect."
        : caught instanceof Error ? caught.message : "Could not pause the microphone for settings.");
    }
  };

  const resumeMicrophoneAfterSettings = async () => {
    if (!settingsMicPaused.current) return;
    const detector = vad.current;
    settingsMicPaused.current = false;
    if (!detector || !started.current || muted.current) return;
    try {
      await vadTransitions.current.start(detector);
      if (vad.current === detector && started.current && !muted.current) {
        detector.setOptions({ submitUserSpeechOnPause: true });
        syncState();
      }
    } catch (caught) {
      if (vad.current !== detector || !started.current || muted.current) return;
      detector.setOptions({ submitUserSpeechOnPause: true });
      deactivateVoice(vadTransitions.current.isInvalid(detector)
        ? "Microphone transition timed out. Tap the shape to reconnect."
        : caught instanceof Error ? caught.message : "Could not resume the microphone after settings.");
    }
  };

  const applySessionEvent = (id: string) => {
    const knownHarness = harnessRef.current;
    if (knownHarness) {
      liveKey.current = `${knownHarness}:${id}`;
      return;
    }
    void fetch("/api/sessions", { headers: authHeaders() })
      .then(checkAuthorized)
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as SessionsResponse;
        const match = result.sessions.find((session) => session.id === id);
        if (!match) return;
        liveKey.current = match.key;
        harnessRef.current = match.harness;
        if (mounted.current) setSessionDisplay({ harness: match.harness, title: match.title, cwd: match.cwd });
      })
      .catch(() => undefined);
  };

  const sendMessage = async (message: string) => {
    const id = ++generation.current;
    let spoken = false;
    const controller = new AbortController();
    chat.current = controller;
    turnVoice.current = readVoicePreference();
    updateState("thinking");
    try {
      if (!message || id !== generation.current) { syncState(); return; }
      assistantAudio.current = "";
      turnVoice.current = readVoicePreference();
      const response = await fetch(`/api/sessions/${encodeURIComponent(liveKey.current)}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders() },
        body: JSON.stringify({ conversationId: conversationId.current, message }), signal: controller.signal,
      });
      checkAuthorized(response);
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Chat request failed.");
      let pending = "";
      await streamTurnEvents(response, (event) => {
        if (id !== generation.current) return;
        switch (event.type) {
          case "session":
            applySessionEvent(event.id);
            return;
          case "status":
            harnessTurnActive.current = true;
            updateState("running");
            setStatusText(event.message);
            return;
          case "tool":
            harnessTurnActive.current = true;
            updateState("running");
            setStatusText(`Using ${event.name}…`);
            return;
          case "delta": {
            if (harnessTurnActive.current) {
              harnessTurnActive.current = false;
              updateState("thinking");
            }
            pending += event.text;
            const result = consumeSpeechChunks(pending);
            pending = result.rest;
            if (result.chunks.length) {
              spoken = true;
              pipeline.current?.enqueue(result.chunks);
            }
            return;
          }
          case "notice":
            setStatusText(event.message);
            spoken = true;
            pipeline.current?.enqueue([event.message]);
            return;
          case "error":
            throw new Error(event.message);
          case "done":
            return;
        }
      });
      if (id === generation.current) {
        const final = consumeSpeechChunks(pending, true);
        if (final.chunks.length) {
          spoken = true;
          pipeline.current?.enqueue(final.chunks);
        }
      }
    } catch (caught) {
      if (caught instanceof UnauthorizedError) {
        if (mounted.current) setUnauthorized(true);
        return;
      }
      if (!(caught instanceof DOMException && caught.name === "AbortError") && id === generation.current) {
        report(caught instanceof Error ? caught.message : "Voice conversation failed.");
        // A turn that dies before any audio is spoken must still produce a spoken reply,
        // so the user is never left in silence.
        if (!spoken) pipeline.current?.enqueue(["Sorry, I could not answer that. Please try again."]);
      }
    } finally {
      if (chat.current === controller) chat.current = null;
      harnessTurnActive.current = false;
      if (mounted.current) setStatusText("");
      syncState();
    }
  };

  const start = async () => {
    if (started.current || starting.current) return;
    starting.current = true;
    const startup = ++startupGeneration.current;
    let context: AudioContext | null = null;
    let microphone: MediaStream | null = null;
    let detector: MicVAD | null = null;
    let acquired: VoiceOwnership | null = null;
    let output: GainNode | null = null;
    let nextPipeline: SpeechPipeline | null = null;
    let nextTranscription: LiveTranscription | null = null;
    let nextInput: VoiceInputCoordinator | null = null;
    const session = ++sessionEpoch.current;
    const ensureCurrentStartup = () => {
      if (!mounted.current || sessionEpoch.current !== session || startupGeneration.current !== startup) {
        throw new DOMException("Voice startup was cancelled.", "AbortError");
      }
    };
    vadTransitions.current.beginSession();
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires HTTPS or localhost.");
      acquired = await acquireVoiceOwnership(handleOwnershipLost);
      if (!acquired) throw new VoiceOwnershipError();
      ensureCurrentStartup();
      setError("");
      updateState("thinking");
      context = new AudioContext();
      await context.resume();
      ensureCurrentStartup();
      output = context.createGain();
      output.gain.value = 1;
      output.connect(context.destination);
      nextPipeline = new SpeechPipeline(synthesize, syncState, (caught) => {
        stopMeter();
        report(caught instanceof Error ? caught.message : "Speech playback failed.");
      });
      nextTranscription = new LiveTranscription(transcribe, () => {});
      nextInput = new VoiceInputCoordinator(
        async (recording, signal) => {
          const transcript = await (nextTranscription?.finish(recording.samples, signal) ?? transcribe(recording.samples, signal));
          return recording.possibleEcho ? removeAssistantEcho(transcript, recording.possibleEcho) : transcript;
        },
        sendMessage,
        (caught) => report(caught instanceof Error ? caught.message : "Voice transcription failed."),
        syncState,
      );
      microphone = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      ensureCurrentStartup();
      const activeMicrophone = microphone;
      const { MicVAD } = await import("@ricky0123/vad-web");
      ensureCurrentStartup();
      detector = await MicVAD.new({
        model: "v5", audioContext: context, startOnLoad: false,
        baseAssetPath: "/voice-assets/", onnxWASMBasePath: "/voice-assets/",
        ortConfig: (ort) => { ort.env.wasm.numThreads = 1; },
        getStream: async () => activeMicrophone, pauseStream: async () => {}, resumeStream: async () => activeMicrophone,
        ...vadOptions,
        submitUserSpeechOnPause: true,
        onSpeechStart: () => {
          if (!isCurrentVad(detector, session)) return;
          input.current?.speechStarted();
          const activeTurn = hasActiveVoiceTurn(Boolean(chat.current), Boolean(pipeline.current?.busy), speaking.current);
          const decision = bargeIn.current.speechStart(activeTurn);
          echoReference.current = speaking.current ? assistantAudio.current : "";
          if (decision.begin) transcription.current?.begin();
          if (decision.duck) duckOutput();
          armAcceptedWatchdog(detector, session);
        },
        onSpeechRealStart: () => {
          if (!isCurrentVad(detector, session)) return;
          const decision = bargeIn.current.speechRealStart();
          if (decision.accepted) {
            if (decision.interrupt) interruptActiveTurn();
            restoreOutput();
            transcription.current?.confirm();
            armAcceptedWatchdog(detector, session);
            setError("");
            updateState("hearing");
          }
        },
        onVADMisfire: () => {
          if (!isCurrentVad(detector, session)) return;
          clearAcceptedWatchdog();
          bargeIn.current.reset();
          echoReference.current = "";
          transcription.current?.discard();
          input.current?.speechDiscarded();
          restoreOutput();
          if (!muted.current) syncState();
        },
        onFrameProcessed: (probabilities, frame) => {
          if (!isCurrentVad(detector, session)) return;
          transcription.current?.frame(probabilities.isSpeech, frame);
          setLevel(Math.min(1, Math.sqrt(frame.reduce((total, value) => total + value * value, 0) / frame.length) * 7));
        },
        onSpeechEnd: (samples) => {
          if (!isCurrentVad(detector, session)) return;
          clearAcceptedWatchdog();
          if (!bargeIn.current.speechEnd()) {
            echoReference.current = "";
            transcription.current?.discard();
            input.current?.speechDiscarded();
            restoreOutput();
            syncState();
            return;
          }
          restoreOutput();
          transcription.current?.end(samples);
          const possibleEcho = echoReference.current;
          echoReference.current = "";
          input.current?.speechEnded({ samples, possibleEcho });
        },
      });
      await vadTransitions.current.start(detector);
      ensureCurrentStartup();
      const activeDetector = detector;
      const activeContext = context;
      if (!activeDetector || !activeContext) throw new Error("Voice startup did not finish.");
      ownership.current = acquired;
      audio.current = activeContext;
      outputGain.current = output;
      pipeline.current = nextPipeline;
      transcription.current = nextTranscription;
      input.current = nextInput;
      stream.current = activeMicrophone;
      vad.current = activeDetector;
      started.current = true;
      const handleMicrophoneEnded = () => {
        if (stream.current !== activeMicrophone || !started.current) return;
        started.current = false;
        settingsMicPaused.current = false;
        sessionEpoch.current++;
        clearAcceptedWatchdog();
        vadTransitions.current.deactivate();
        muted.current = false;
        abortTurn();
        restoreOutput();
        bargeIn.current.reset();
        pipeline.current = null;
        transcription.current?.reset();
        transcription.current = null;
        input.current?.reset();
        input.current = null;
        if (vad.current === activeDetector) vad.current = null;
        if (stream.current === activeMicrophone) stream.current = null;
        if (audio.current === activeContext) audio.current = null;
        outputGain.current?.disconnect();
        outputGain.current = null;
        for (const track of activeMicrophone.getTracks()) {
          track.onended = null;
          if (track.readyState === "live") track.stop();
        }
        void activeDetector.destroy().catch(() => undefined);
        if (activeContext.state !== "closed") void activeContext.close().catch(() => undefined);
        releaseOwnership();
        report("Microphone disconnected. Tap the shape to reconnect.");
      };
      for (const track of activeMicrophone.getAudioTracks()) track.onended = handleMicrophoneEnded;
      if (!activeMicrophone.getAudioTracks().some((track) => track.readyState === "live")) {
        handleMicrophoneEnded();
        return;
      }
      updateState("listening");
      if (settingsOpenRef.current) void pauseMicrophoneForSettings();
    } catch (caught) {
      const currentStartup = sessionEpoch.current === session && startupGeneration.current === startup;
      if (currentStartup) {
        sessionEpoch.current++;
        clearAcceptedWatchdog();
        vadTransitions.current.deactivate();
        if (vad.current === detector) vad.current = null;
        if (stream.current === microphone) stream.current = null;
        if (audio.current === context) audio.current = null;
        if (outputGain.current === output) outputGain.current = null;
        if (pipeline.current === nextPipeline) pipeline.current = null;
        if (transcription.current === nextTranscription) transcription.current = null;
        if (input.current === nextInput) input.current = null;
      }
      nextPipeline?.cancel();
      nextTranscription?.reset();
      nextInput?.reset();
      output?.disconnect();
      if (detector) await detector.destroy().catch(() => undefined);
      microphone?.getTracks().forEach((track) => track.stop());
      if (context && context.state !== "closed") await context.close().catch(() => undefined);
      if (ownership.current === acquired) ownership.current = null;
      acquired?.release();
      if (currentStartup && !(caught instanceof DOMException && caught.name === "AbortError")) {
        report(caught instanceof Error ? caught.message : "Could not start the microphone.");
      }
    } finally {
      if (startupGeneration.current === startup) starting.current = false;
    }
  };

  const isCurrentVad = (candidate: MicVAD | null, session: number) => (
    (started.current || starting.current)
    && !settingsOpenRef.current
    && isCurrentVoiceSession(
      sessionEpoch.current,
      session,
      vad.current,
      candidate,
      muted.current,
      vadTransitions.current.acceptsCallbacks,
    )
  );

  const ownsCurrentVad = (candidate: MicVAD | null, expectedMuted: boolean, session?: number) => (
    candidate !== null
    && vad.current === candidate
    && started.current
    && muted.current === expectedMuted
    && (session === undefined || sessionEpoch.current === session)
  );

  const isReadyVadTransition = (candidate: MicVAD | null, expectedMuted: boolean, session?: number) => (
    ownsCurrentVad(candidate, expectedMuted, session)
    && candidate !== null
    && !vadTransitions.current.isInvalid(candidate)
  );

  const armAcceptedWatchdog = (candidate: MicVAD | null, session: number) => {
    clearAcceptedWatchdog();
    if (!candidate) return;
    acceptedWatchdog.current = window.setTimeout(() => {
      acceptedWatchdog.current = null;
      if (!isCurrentVad(candidate, session)) return;
      // VAD normally delivers onSpeechEnd. This only recovers a stuck accepted
      // segment by using vad-web's normal pause flush, then reconnecting it.
      void vadTransitions.current.flush(candidate).then(() => {
        // A session can be torn down while its serialized flush is pending.
        // Do not let that stale completion affect its replacement.
        if (!isReadyVadTransition(candidate, false, session)) return;
      }).catch((caught) => {
        if (!ownsCurrentVad(candidate, false, session)) return;
        if (vadTransitions.current.isInvalid(candidate)) {
          deactivateVoice("Microphone transition timed out. Tap the shape to reconnect.");
        } else {
          report(caught instanceof Error ? caught.message : "Microphone recovery failed.");
        }
      });
    }, acceptedSpeechWatchdogMs);
  };

  const toggle = async () => {
    if (!started.current) {
      if (!starting.current) void start();
      return;
    }
    muted.current = !muted.current;
    if (muted.current) {
      clearAcceptedWatchdog();
      abortTurn();
      restoreOutput();
      bargeIn.current.reset();
      transcription.current?.reset();
      input.current?.reset();
      stream.current?.getTracks().forEach((track) => { track.enabled = false; });
      const detector = vad.current;
      if (!ownsCurrentVad(detector, true)) return;
      detector?.setOptions({ submitUserSpeechOnPause: false });
      try {
        if (detector) await vadTransitions.current.pause(detector);
        if (!isReadyVadTransition(detector, true)) {
          if (ownsCurrentVad(detector, true) && detector && vadTransitions.current.isInvalid(detector)) {
            deactivateVoice("Microphone transition timed out. Tap the shape to reconnect.");
          }
          return;
        }
        updateState("muted");
      } catch (caught) {
        if (!ownsCurrentVad(detector, true)) return;
        if (detector && vadTransitions.current.isInvalid(detector)) {
          deactivateVoice("Microphone transition timed out. Tap the shape to reconnect.");
        } else {
          report(caught instanceof Error ? caught.message : "Could not pause the microphone.");
        }
      }
    } else {
      stream.current?.getTracks().forEach((track) => { track.enabled = true; });
      const detector = vad.current;
      if (!ownsCurrentVad(detector, false)) return;
      try {
        if (detector) {
          await vadTransitions.current.start(detector);
          if (!isReadyVadTransition(detector, false)) {
            if (ownsCurrentVad(detector, false) && vadTransitions.current.isInvalid(detector)) {
              deactivateVoice("Microphone transition timed out. Tap the shape to reconnect.");
            }
            return;
          }
          detector.setOptions({ submitUserSpeechOnPause: true });
        }
        if (!isReadyVadTransition(detector, false)) return;
        updateState("listening");
      } catch (caught) {
        if (!ownsCurrentVad(detector, false)) return;
        if (detector && vadTransitions.current.isInvalid(detector)) {
          deactivateVoice("Microphone transition timed out. Tap the shape to reconnect.");
        } else {
          report(caught instanceof Error ? caught.message : "Could not resume the microphone.");
        }
      }
    }
  };

  const reconnect = () => {
    closeMenus();
    setError("");
    if (started.current || starting.current) {
      deactivateVoice("");
      window.setTimeout(() => {
        if (!started.current && !starting.current) void start();
      }, 0);
      return;
    }
    void start();
  };

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/sessions", { headers: authHeaders(), signal: controller.signal })
      .then(checkAuthorized)
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as SessionsResponse;
        const match = result.sessions.find((session) => session.key === sessionKey);
        if (match && !controller.signal.aborted) {
          harnessRef.current = match.harness;
          setSessionDisplay({ harness: match.harness, title: match.title, cwd: match.cwd });
        }
      })
      .catch((caught) => {
        if (caught instanceof UnauthorizedError && !controller.signal.aborted) setUnauthorized(true);
      });
    return () => controller.abort();
  }, [sessionKey]);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void fetch("/api/health").then(async (response) => {
        const result = await response.json().catch(() => ({})) as HealthResponse;
        if (cancelled) return;
        const speech = result.speech ?? {};
        setSpeechHealth({
          ready: speech.ready !== false,
          downloading: speech.downloading === true,
          progress: typeof speech.progress === "number" ? speech.progress : undefined,
          error: typeof speech.error === "string" ? speech.error : undefined,
        });
      }).catch(() => undefined);
    };
    poll();
    const interval = window.setInterval(poll, healthPollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  useEffect(() => {
    settingsOpenRef.current = settingsOpen;
    if (settingsOpen) void pauseMicrophoneForSettings();
    else void resumeMicrophoneAfterSettings();
    if (!settingsOpen) {
      if (previewVoice) stopPreview();
      voicesRequest.current?.abort();
      voicesRequest.current = null;
      return;
    }
    setVoiceError("");
    setVoiceNotice("");
    loadVoiceList(readVoicePreference() ?? undefined);
  }, [settingsOpen]);

  useEffect(() => {
    if (!contextMenu && !settingsOpen) return;
    const handleOutsidePointer = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && (contextMenuRef.current?.contains(target) || settingsRef.current?.contains(target))) return;
      closeMenus();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeMenus();
      }
    };
    document.addEventListener("pointerdown", handleOutsidePointer);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handleOutsidePointer);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [contextMenu, settingsOpen]);

  useEffect(() => {
    if (settingsOpen) window.setTimeout(() => voiceSelectRef.current?.focus(), 0);
  }, [settingsOpen]);

  useEffect(() => () => {
    mounted.current = false;
    errorToken.current++;
    if (errorTimer.current !== null) window.clearTimeout(errorTimer.current);
    errorTimer.current = null;
    started.current = false;
    clearLongPress();
    voicesRequest.current?.abort();
    previewRequest.current?.abort();
    previewRequest.current = null;
    previewPlayback.current = null;
    if (previewContext.current && previewContext.current.state !== "closed") void previewContext.current.close().catch(() => undefined);
    previewContext.current = null;
    sessionEpoch.current++;
    clearAcceptedWatchdog();
    vadTransitions.current.deactivate();
    abortTurn();
    restoreOutput();
    bargeIn.current.reset();
    transcription.current?.reset();
    input.current?.reset();
    input.current = null;
    void vad.current?.destroy();
    stream.current?.getTracks().forEach((track) => {
      track.onended = null;
      track.stop();
    });
    void audio.current?.close();
    outputGain.current?.disconnect();
    outputGain.current = null;
    releaseOwnership();
  }, []);

  if (unauthorized) return <UnauthorizedScreen />;

  const label = !started.current ? "Start voice conversation" : state === "muted" ? "Unmute microphone" : "Mute microphone";
  const contextLeft = contextMenu ? Math.max(12, Math.min(contextMenu.x, window.innerWidth - 170)) : 0;
  const contextTop = contextMenu ? Math.max(12, Math.min(contextMenu.y, window.innerHeight - 68)) : 0;
  const activeVoice = savedVoice || profileVoice;
  const speechReady = speechHealth.ready;
  const speechStatusLabel = speechHealth.ready
    ? "Ready"
    : speechHealth.downloading
      ? `Downloading voice models…${typeof speechHealth.progress === "number" ? ` ${Math.round(speechHealth.progress)}%` : ""}`
      : "Offline";
  return <main className="voice-page" data-state={state} style={{ "--level": level } as CSSProperties}>
    <header className="room-header">
      <a className="room-header__back" href="/" aria-label="Back to hub">←</a>
      <span className="room-header__title">
        {sessionDisplay.harness ? harnessLabel[sessionDisplay.harness] : "Meldivo"} · {sessionDisplay.title}
      </span>
      {sessionDisplay.cwd && <span className="room-header__cwd">{sessionDisplay.cwd}</span>}
    </header>
    {statusText && <p className="room-status" role="status">{statusText}</p>}
    {!speechHealth.ready && <p className="voice-health" role="status">
      {speechHealth.error || speechStatusLabel}
    </p>}
    <button
      className="voice-shape"
      type="button"
      onClick={() => {
        if (Date.now() < suppressClickUntil.current) {
          suppressClickUntil.current = 0;
          return;
        }
        if (contextMenu || settingsOpen) {
          closeMenus();
          return;
        }
        void toggle();
      }}
      onPointerDown={handlePointerDown}
      onPointerMove={handlePointerMove}
      onPointerUp={clearLongPress}
      onPointerCancel={clearLongPress}
      onPointerLeave={clearLongPress}
      onLostPointerCapture={clearLongPress}
      onContextMenu={(event) => {
        event.preventDefault();
        openContextMenu(event.clientX, event.clientY);
      }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.key === "F10" && event.shiftKey)) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openContextMenu(rect.left + rect.width / 2, rect.top + rect.height / 2);
        }
      }}
      aria-label={label}
      aria-haspopup="menu"
      aria-expanded={Boolean(contextMenu || settingsOpen)}
    >
      <span className="voice-shape__halo" />
      <span className="voice-shape__ring voice-shape__ring--one" />
      <span className="voice-shape__ring voice-shape__ring--two" />
      <span className="voice-shape__core" />
    </button>
    {contextMenu && <div
      ref={contextMenuRef}
      className="voice-context-menu"
      role="menu"
      aria-label="Voice options"
      style={{ left: contextLeft, top: contextTop }}
    >
      <button type="button" role="menuitem" onClick={() => { setContextMenu(null); setSettingsOpen(true); }}>Settings</button>
    </div>}
    {settingsOpen && <div
      ref={settingsRef}
      className="voice-settings"
      role="dialog"
      aria-modal="false"
      aria-labelledby="voice-settings-title"
      onKeyDown={(event) => { if (event.key === "Escape") { event.preventDefault(); closeMenus(); } }}
    >
      <div className="voice-settings__header">
        <h2 id="voice-settings-title">Voice</h2>
        <button className="voice-settings__close" type="button" onClick={closeMenus} aria-label="Close voice settings">×</button>
      </div>
      <p id="tts-provider-status" className={`voice-settings__availability voice-settings__availability--${speechHealth.ready ? "ready" : speechHealth.downloading ? "checking" : "offline"}`} role="status">
        <span aria-hidden="true" />
        {speechStatusLabel}
      </p>
      {speechHealth.error && <p className="voice-settings__availability-note">{speechHealth.error}</p>}
      {voiceCatalogWarning && <p className="voice-settings__availability-note">{voiceCatalogWarning}</p>}
      {voiceLoading && <p className="voice-settings__muted">Loading voices…</p>}
      {!voiceLoading && voiceList.length > 0 && <>
        <label className="voice-settings__label" htmlFor="voice-choice">Choose a voice</label>
        <div className="voice-settings__choice">
          <select
            ref={voiceSelectRef}
            id="voice-choice"
            value={selectedVoice}
            onChange={(event) => { stopPreview(); setSelectedVoice(event.target.value); setVoiceError(""); setVoiceNotice(""); }}
            aria-describedby="voice-current"
          >
            {voiceList.map((voice) => <option key={voice} value={voice}>{friendlyLabel(voice)}</option>)}
          </select>
          <button className="voice-settings__play" type="button" onClick={() => { void playPreview(); }} disabled={!selectedVoice || !speechReady || Boolean(previewVoice)} aria-label={`Preview ${selectedVoice || "voice"}`} aria-describedby="tts-provider-status" title={!speechReady ? "Wait for voice models to be ready." : undefined}>
            {previewVoice ? "…" : "▶"}
          </button>
        </div>
        <p id="voice-current" className="voice-settings__current">Current: {activeVoice ? friendlyLabel(activeVoice) : "profile default"}</p>
        <div className="voice-settings__actions">
          <button type="button" onClick={applyVoice} disabled={!selectedVoice || !speechReady || selectedVoice === activeVoice} aria-describedby="tts-provider-status" title={!speechReady ? "Wait for voice models to be ready." : undefined}>Use this voice</button>
          <button type="button" onClick={resetVoice} disabled={!savedVoice}>Restore default</button>
        </div>
      </>}
      {!voiceLoading && !voiceList.length && <>
        <p className="voice-settings__muted">No selectable voices are configured.</p>
      </>}
      {voiceError && <p className="voice-settings__error" role="alert">{voiceError}</p>}
      {voiceNotice && <p className="voice-settings__notice" role="status">{voiceNotice}</p>}
    </div>}
    {onboardingOpen && <div className="voice-onboarding" role="dialog" aria-modal="true" aria-labelledby="voice-onboarding-title">
      <div className="voice-onboarding__card">
        <h2 id="voice-onboarding-title">Welcome</h2>
        <p>Tap to talk · hold or right-click for settings.</p>
        <button type="button" onClick={() => {
          try { window.localStorage.setItem(onboardingDismissedKey, "true"); } catch { /* Storage is optional. */ }
          setOnboardingOpen(false);
        }}>OK</button>
      </div>
    </div>}
    {error && <div className="voice-error" role="alert" title={error}>
      <span>{error}</span>
      <button className="voice-error__reconnect" type="button" onClick={reconnect}>Reconnect</button>
    </div>}
  </main>;
}

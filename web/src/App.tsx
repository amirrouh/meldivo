import { useEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";
import type { MicVAD } from "@ricky0123/vad-web";
import { removeAssistantEcho } from "./assistant-echo";
import { isCurrentVoiceSession, SerializedVadTransitions, VoiceInputCoordinator } from "./input-coordinator";
import { LiveTranscription } from "./live-transcription";
import {
  acousticGateFrames, BargeInGuard, estimatePhraseSeconds, findDeliberateCue, isBelowEchoFloor, isMeaningfulSpeech,
  meaningfulSpeechMs, previewFreshnessMs, recentPlaybackWindow, recordPlayedPhrase, type PlayedPhrase,
} from "./barge-in-guard";
import { prepareAudioBuffer, prepareAudioStream } from "./audio-playback";
import { SpeechPipeline, type PreparedSpeech } from "./speech-pipeline";
import { cutSentence } from "./cut-sentence";
import { fetchResumeBridge, withBridge } from "./resume-bridge";
import {
  vadNegativeSpeechThreshold, vadOptionsFor, vadPositiveSpeechThreshold, vadRedemptionMsMax, vadRedemptionMsMin, vadRedemptionMsStep,
} from "./vad-config";
import { loadVadModule, preloadVoiceDetector, voiceAssetBase } from "./vad-preload";
import { readVadRedemptionMs, writeVadRedemptionMs } from "./vad-preference";
import { EnergyVad } from "./energy-vad";
import {
  beginTurn, cueIdlePollMs, cuePhrases, cueSynthesisDelayMs, dueForCue, endTurn, freshCueState, noteCuePlayed, noteSpoken, pickCue,
} from "./working-cues";

// A detector is either the real Silero MicVAD or the energy-based fallback;
// both implement the same start/pause/destroy/setOptions + callback contract.
type Detector = MicVAD | EnergyVad;

// If Silero/onnxruntime-web fails to initialize once in this page, it will
// not recover in-page (observed on Safari: ORT wasm backend can be left
// wedged after repeated reloads/tabs). Remember that across start()/Reconnect
// calls for the lifetime of the page so we go straight to the energy fallback
// instead of repeatedly retrying a doomed Silero init.
let sileroInitFailed = false;
import { consumeSpeechChunks, hasActiveVoiceTurn, samplesWav } from "./voice";
import { acquireVoiceOwnership, type VoiceOwnership } from "./voice-ownership";
import { clearVoicePreference, readVoicePreference, writeVoicePreference } from "./voice-preference";
import { uid } from "./uid";
import { authHeaders, checkAuthorized, UnauthorizedError } from "./auth";
import { UnauthorizedScreen } from "./UnauthorizedScreen";
import { ToolActivityStack, useToolActivity } from "./ToolActivity";
import { harnessLabel, splitHostKey, type HarnessId, type SessionsResponse, type TurnEvent } from "./session-types";

interface AppProps {
  sessionKey: string;
  /** Folder a new chat starts in (absolute path); the home folder when unset. */
  folder?: string;
}

type SessionDisplay = { harness?: HarnessId; title: string; cwd: string; host?: string };

function deriveSessionDisplay(fullKey: string): SessionDisplay {
  const { host: hostName, inner: key } = splitHostKey(fullKey);
  const host = hostName || undefined;
  if (key.startsWith("new:")) return { harness: key.slice(4) as HarnessId, title: "New chat", cwd: "~", host };
  if (key === "quick") return { title: "Quick chat", cwd: "~", host };
  const separator = key.indexOf(":");
  if (separator === -1) return { title: key, cwd: "", host };
  return { harness: key.slice(0, separator) as HarnessId, title: key.slice(separator + 1), cwd: "", host };
}

function shortFolder(cwd: string): string {
  const home = /^(\/home\/[^/]+|\/Users\/[^/]+)(\/.*)?$/.exec(cwd);
  return home ? `~${home[2] ?? ""}` : cwd;
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

type VoiceState = "idle" | "loading" | "listening" | "hearing" | "thinking" | "running" | "speaking" | "muted" | "error";
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

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason);
    const timer = window.setTimeout(() => { signal.removeEventListener("abort", cancel); resolve(); }, ms);
    const cancel = () => { window.clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", cancel, { once: true });
  });
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

export default function App({ sessionKey, folder }: AppProps) {
  const [state, setState] = useState<VoiceState>("idle");
  const [level, setLevel] = useState(0);
  const [error, setError] = useState("");
  const stateRef = useRef(state);
  const mounted = useRef(true);
  const muted = useRef(false);
  const started = useRef(false);
  const starting = useRef(false);
  const speaking = useRef(false);
  const vad = useRef<Detector | null>(null);
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
  const conversationId = useRef(getConversationId(folder ? `${sessionKey}|${folder}` : sessionKey));
  const liveKey = useRef(sessionKey);
  // The key the server registered the in-flight turn's AbortController under (the
  // request key at POST time). A "new:<harness>" turn rewrites liveKey to the
  // resolved "<harness>:<id>" as soon as its SSE "session" event arrives, which can
  // happen well before the turn ends - cancelling with the rewritten liveKey would
  // then 404 against a server-side map still keyed by the original request key.
  const activeChatKey = useRef<string | null>(null);
  const harnessRef = useRef<HarnessId | undefined>(deriveSessionDisplay(sessionKey).harness);
  const generation = useRef(0);
  const outputFrame = useRef(0);
  const meterOwner = useRef<symbol | null>(null);
  const assistantAudio = useRef("");
  const echoReference = useRef("");
  const ownership = useRef<VoiceOwnership | null>(null);
  const bargeIn = useRef(new BargeInGuard());
  const partialTranscript = useRef("");
  // When the live preview text was last updated, so speechEnd can tell a fresh preview
  // (safe to judge on the spot) from a stale or missing one (never used to drop speech).
  const partialTranscriptAt = useRef(0);
  // Every phrase recently played (a reply or a working cue), so an interruption can be
  // judged against what the mic could actually be hearing back, not the whole turn so far.
  const playedPhrases = useRef<PlayedPhrase[]>([]);
  // The played-phrase window captured once at the start of the current speech candidate;
  // reused for every check (mid-speech and at speech end) against that same candidate.
  const recentWindow = useRef("");
  // Echo floor: a running estimate of the mic's own RMS level while the assistant is
  // speaking and no speech candidate is open - i.e. residual echo, not real speech.
  const echoFloor = useRef<number | null>(null);
  const candidateGateFrames = useRef(0);
  const candidateGateRmsSum = useRef(0);
  const candidateGateDecided = useRef(false);
  const interruptTimer = useRef<number | null>(null);
  // The phrase the speech pipeline is currently playing: its full text, when its audio actually
  // started, and its expected duration (refined to the real PCM length once known). Used only to
  // estimate how far into it a barge-in pause landed; cleared once the phrase finishes normally.
  const currentPhrase = useRef<{ text: string; startedAt: number; seconds: number } | null>(null);
  // Set the moment a barge-in's acoustic gate pauses the reply (see pauseForBargeIn), and cleared
  // the moment its fate is decided (resumed or the turn is aborted). Guards every "bring the
  // paused reply back" call site against firing when nothing was actually paused.
  const bargePaused = useRef(false);
  // What to resume with, captured at pause time: the sentence that was cut off, and (for the
  // hub's bridge phrase) roughly what had already been said just before it.
  const pendingResume = useRef<{ said: string; resume: string } | null>(null);
  const cueState = useRef(freshCueState());
  const cueAudioCache = useRef(new Map<string, AudioBuffer>());
  const cueController = useRef<AbortController | null>(null);
  const cueWatcher = useRef<number | null>(null);
  const cueSynthesis = useRef<AbortController | null>(null);
  const cueFetch = useRef<AbortController | null>(null);
  const lastPipelineActivity = useRef(0);
  // What the listener feels, per turn: from the end of their speech to the first word they hear.
  const turnTiming = useRef<{ speechEnd?: number; sent?: number; firstDelta?: number; reported?: boolean }>({});
  const turnVoice = useRef<string>();
  const [contextMenu, setContextMenu] = useState<ContextMenuPosition | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [voiceList, setVoiceList] = useState<string[]>([]);
  const [profileVoice, setProfileVoice] = useState("");
  const [selectedVoice, setSelectedVoice] = useState(() => readVoicePreference() ?? "");
  const [savedVoice, setSavedVoice] = useState(() => readVoicePreference() ?? "");
  const [vadRedemptionMs, setVadRedemptionMs] = useState(() => readVadRedemptionMs());
  const [speechHealth, setSpeechHealth] = useState<SpeechHealth>({ ready: true, downloading: false });
  const [sessionDisplay, setSessionDisplay] = useState<SessionDisplay>(() => {
    const display = deriveSessionDisplay(sessionKey);
    return folder && splitHostKey(sessionKey).inner.startsWith("new:") ? { ...display, cwd: shortFolder(folder) } : display;
  });
  const [unauthorized, setUnauthorized] = useState(false);
  const [statusText, setStatusText] = useState("");
  const toolActivity = useToolActivity();
  const [usingFallbackVad, setUsingFallbackVad] = useState(false);
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
  const clearInterruptTimer = () => {
    if (interruptTimer.current !== null) window.clearTimeout(interruptTimer.current);
    interruptTimer.current = null;
  };
  const stopCueWatcher = () => {
    if (cueWatcher.current !== null) window.clearInterval(cueWatcher.current);
    cueWatcher.current = null;
    cueController.current?.abort();
    cueController.current = null;
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
  // Has the agent's model read the whole conversation before the user speaks, so the first
  // reply only has to read the new sentence. The server runs it on a throwaway fork. Started
  // at page load; the microphone works meanwhile (the server holds the first turn until the
  // warm-up is done), so it never shows a loading state.
  const warming = useRef(false);
  const warmingStatus = "Reading the conversation…";
  const warmConversation = async () => {
    const key = liveKey.current;
    const { inner } = splitHostKey(key);
    if (warming.current || !inner.includes(":") || inner.startsWith("new:")) return;
    warming.current = true;
    setStatusText(warmingStatus);
    try {
      await fetch(`/api/sessions/${encodeURIComponent(key)}/warm`, { method: "POST", headers: authHeaders() });
    } catch {
      // The first turn is just slower; nothing to report.
    } finally {
      warming.current = false;
      // A turn may have replaced the status line meanwhile; only clear our own.
      if (mounted.current) setStatusText((current) => (current === warmingStatus ? "" : current));
    }
  };
  // Restores the output gain to full volume. No longer used to undo an interruption (see
  // pauseForBargeIn/resumeAfterBargeIn below, which pause and resume the speech pipeline
  // itself instead of the gain), but kept as a safety net for anything that ever left it down.
  const restoreOutput = () => {
    const gain = outputGain.current;
    const context = audio.current;
    if (!gain || !context) return;
    gain.gain.cancelScheduledValues(context.currentTime);
    gain.gain.setTargetAtTime(1, context.currentTime, 0.015);
  };
  // Called at a barge-in's acoustic-gate pass (~0.25s into a candidate that is clearly louder
  // than the learned echo floor): pauses the reply in place - a short fade, no click, via
  // SpeechPipeline.hold() - instead of just muting it, so the words themselves are not lost.
  // The phrase that was interrupted is cut at the sentence containing the estimated position
  // playback had reached, and everything from there on (including anything queued behind it) is
  // remembered so it can be resumed, preceded by a bridge phrase, if the interruption turns out
  // not to be meaningful (see resumeAfterBargeIn).
  // What the barge-in logic decided, for the hub log: kinds and counts only, never any words.
  const logVoiceEvent = (kind: string, fields: Record<string, number | boolean> = {}) => {
    void fetch("/api/voice/event", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ kind, ...fields }),
    }).catch(() => undefined);
  };
  const resumeWatchdog = useRef<number | null>(null);
  const pauseForBargeIn = () => {
    const held = pipeline.current?.hold() ?? false;
    logVoiceEvent("barge_pause", { held });
    if (!held) return;
    bargePaused.current = true;
    // Safety net: whatever path the interruption takes, a reply is never left paused once the
    // user has gone quiet and nothing is still deciding its fate.
    if (resumeWatchdog.current !== null) window.clearInterval(resumeWatchdog.current);
    let quietSince = 0;
    resumeWatchdog.current = window.setInterval(() => {
      if (!bargePaused.current) {
        window.clearInterval(resumeWatchdog.current!);
        resumeWatchdog.current = null;
        return;
      }
      const deciding = stateRef.current === "hearing" || Boolean(input.current?.busy);
      quietSince = deciding ? 0 : quietSince || Date.now();
      if (quietSince && Date.now() - quietSince >= 2_500) {
        logVoiceEvent("barge_resume_watchdog");
        resumeAfterBargeIn();
      }
    }, 250);
    const phrase = currentPhrase.current;
    currentPhrase.current = null;
    if (phrase) {
      const elapsedSeconds = (performance.now() - phrase.startedAt) / 1_000;
      const fraction = phrase.seconds > 0 ? elapsedSeconds / phrase.seconds : 1;
      const resume = cutSentence(phrase.text, fraction);
      // What was said just before the cut, for the hub's bridge phrase - the whole phrase is
      // a suffix of assistantAudio (appended in full when it started playing), so what led up
      // to the cut is whatever remains once the resumed suffix is removed from the end of it.
      const said = assistantAudio.current.slice(0, assistantAudio.current.length - resume.length).trim();
      pendingResume.current = resume ? { said, resume } : null;
    } else {
      pendingResume.current = null;
    }
  };
  // Brings a paused reply back once a barge-in turns out not to be a real interruption (no
  // meaningful words, or none by the time speech ended): asks the hub for a short bridge phrase
  // and resumes the speech pipeline with it, in front of the sentence that was cut off (which is
  // itself followed by whatever was already queued). A no-op unless pauseForBargeIn actually
  // paused something. If there is nothing left to resume (the phrase had already finished), the
  // pipeline is simply released to carry on with whatever is queued - nothing new is spoken.
  const resumeAfterBargeIn = () => {
    if (!bargePaused.current) return;
    bargePaused.current = false;
    const pending = pendingResume.current;
    pendingResume.current = null;
    const target = pipeline.current;
    logVoiceEvent("barge_resume", { with_sentence: Boolean(pending) });
    if (!target || !pending) {
      target?.resume("");
      return;
    }
    void fetchResumeBridge(pending.said, pending.resume, authHeaders()).then((bridge) => {
      if (pipeline.current !== target) return;
      target.resume(withBridge(bridge, pending.resume));
    });
  };
  // Something the user is part of is under way (heard, transcribed, answered or spoken);
  // cue synthesis must not compete with it for the speech server.
  const turnInProgress = () => (
    Boolean(chat.current) || Boolean(pipeline.current?.busy) || speaking.current
    || Boolean(input.current?.busy) || stateRef.current === "hearing"
  );
  // Fetches and decodes every working-cue phrase once so a cue can play instantly
  // later, from cache, instead of paying TTS latency right when it is needed. Starts a
  // few seconds after listening begins and only runs between turns, so it never delays a reply.
  const synthesizeCues = async (context: AudioContext) => {
    cueSynthesis.current?.abort();
    cueFetch.current?.abort();
    const run = new AbortController();
    cueSynthesis.current = run;
    cueAudioCache.current.clear();
    const voice = readVoicePreference();
    const current = () => audio.current === context && !run.signal.aborted;
    try {
      await abortableDelay(cueSynthesisDelayMs, run.signal);
      // One at a time: a speech server may refuse several requests at once.
      for (const phrase of cuePhrases) {
        while (current()) {
          while (current() && turnInProgress()) await abortableDelay(cueIdlePollMs, run.signal);
          if (!current()) return;
          const request = new AbortController();
          cueFetch.current = request;
          try {
            const response = await fetch("/api/voice/speech", {
              method: "POST",
              headers: { "Content-Type": "application/json", Accept: "audio/wav", ...authHeaders() },
              body: JSON.stringify({ text: phrase, ...(voice ? { voice } : {}) }),
              signal: request.signal,
            });
            if (!current() || !response.ok) break;
            const bytes = await response.arrayBuffer();
            if (!current()) return;
            const buffer = await context.decodeAudioData(bytes);
            if (current()) cueAudioCache.current.set(phrase, buffer);
            break;
          } catch {
            // A turn that starts aborts the request; retry this phrase once it is over.
            // Any other failure skips the cue: cues are polish, not required.
            if (!request.signal.aborted) break;
          } finally {
            if (cueFetch.current === request) cueFetch.current = null;
          }
        }
      }
    } catch {
      // Superseded by a newer synthesis (voice change or new session).
    } finally {
      if (cueSynthesis.current === run) cueSynthesis.current = null;
    }
  };
  const playWorkingCue = async (text: string, signal: AbortSignal) => {
    const context = audio.current;
    const buffer = cueAudioCache.current.get(text);
    if (!context || !buffer) return;
    const playback = Symbol("cue");
    // Set for echo removal exactly like a real reply, so a barge-in over a cue works.
    const priorAssistantAudio = assistantAudio.current;
    assistantAudio.current = text;
    playedPhrases.current = recordPlayedPhrase(playedPhrases.current, text, performance.now());
    const prepared = prepareAudioBuffer(buffer, context, outputGain.current ?? context.destination, (analyser) => startMeter(analyser, playback));
    try {
      await prepared(signal);
    } catch {
      // Cancelled by real speech starting, a barge-in, or the turn ending.
    } finally {
      stopMeter(playback);
      if (assistantAudio.current === text) assistantAudio.current = priorAssistantAudio;
      syncState();
    }
  };
  // While a turn is active and nothing is playing or queued in the speech pipeline,
  // speaks a short filler cue so the user knows the assistant is still working.
  const armCueWatcher = () => {
    stopCueWatcher();
    cueWatcher.current = window.setInterval(() => {
      if (!cueState.current.turnActive) { stopCueWatcher(); return; }
      if (speaking.current || pipeline.current?.busy || cueController.current) return;
      const now = Date.now();
      const silentForMs = now - lastPipelineActivity.current;
      if (!dueForCue(cueState.current, silentForMs, now)) return;
      const text = pickCue(cueState.current);
      cueState.current = noteCuePlayed(cueState.current, text, now);
      const controller = new AbortController();
      cueController.current = controller;
      void playWorkingCue(text, controller.signal).finally(() => {
        if (cueController.current === controller) cueController.current = null;
        lastPipelineActivity.current = Date.now();
      });
    }, 300);
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
    // A reply paused by a barge-in is gone now, along with anything it would have resumed with;
    // the next one plays at full volume from a fresh pipeline run.
    restoreOutput();
    bargePaused.current = false;
    pendingResume.current = null;
    currentPhrase.current = null;
    cueState.current = endTurn(cueState.current);
    stopCueWatcher();
    if (wasActive) {
      const key = activeChatKey.current ?? liveKey.current;
      void fetch(`/api/sessions/${encodeURIComponent(key)}/cancel`, {
        method: "POST", headers: authHeaders(),
      }).catch(() => undefined);
    }
    activeChatKey.current = null;
    if (!muted.current && started.current) updateState("listening");
  };
  const interruptActiveTurn = () => {
    const active = hasActiveVoiceTurn(Boolean(chat.current), Boolean(pipeline.current?.busy), speaking.current);
    logVoiceEvent("barge_interrupt", { active, paused: bargePaused.current });
    if (active) abortTurn();
  };
  const deactivateVoice = (message: string) => {
    if (!started.current && !starting.current) return;
    started.current = false;
    starting.current = false;
    settingsMicPaused.current = false;
    setUsingFallbackVad(false);
    sessionEpoch.current++;
    clearAcceptedWatchdog();
    vadTransitions.current.deactivate();
    muted.current = false;
    abortTurn();
    restoreOutput();
    bargeIn.current.reset();
    clearInterruptTimer();
    partialTranscript.current = "";
    partialTranscriptAt.current = 0;
    recentWindow.current = "";
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
    setUsingFallbackVad(false);
    sessionEpoch.current++;
    clearAcceptedWatchdog();
    vadTransitions.current.deactivate();
    muted.current = false;
    abortTurn();
    restoreOutput();
    bargeIn.current.reset();
    clearInterruptTimer();
    partialTranscript.current = "";
    partialTranscriptAt.current = 0;
    recentWindow.current = "";
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

  // Sends one turn's durations (never any text) to the server log, once, when its first word plays.
  const reportTurnTiming = () => {
    const timing = turnTiming.current;
    if (timing.reported || timing.sent === undefined) return;
    timing.reported = true;
    const now = performance.now();
    const ms = (from?: number, to?: number) => (from === undefined || to === undefined ? undefined : Math.round(to - from));
    void fetch("/api/voice/timing", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        silence_wait_ms: vad.current ? readVadRedemptionMs() : undefined,
        speech_end_to_send_ms: ms(timing.speechEnd, timing.sent),
        send_to_first_word_ms: ms(timing.sent, timing.firstDelta),
        first_word_to_sound_ms: ms(timing.firstDelta, now),
        speech_end_to_sound_ms: ms(timing.speechEnd, now),
      }),
    }).catch(() => undefined);
  };
  const synthesize = async (text: string, signal: AbortSignal): Promise<PreparedSpeech> => {
    const context = audio.current;
    if (!context) throw new Error("Audio output is not ready.");
    const playback = Symbol("playback");
    // The best known spoken duration of this phrase: refined below once the stream's actual PCM
    // length is known, or set from the decoded buffer's exact duration for a non-streamed reply.
    let expectedSeconds = estimatePhraseSeconds(text);
    const playbackStarted = (analyser: AnalyserNode) => {
      // The real reply wins over a working cue that happens to still be playing.
      cueController.current?.abort();
      reportTurnTiming();
      // Everything said this turn, so echo of an earlier sentence is recognized too
      // (used only to strip an echoed prefix from what gets sent; see removeAssistantEcho).
      assistantAudio.current = `${assistantAudio.current} ${text.trim()}`.trim().slice(-2000);
      // Recorded separately, with a timestamp, so a barge-in can be judged against what
      // was actually playing recently rather than the whole turn's text.
      playedPhrases.current = recordPlayedPhrase(playedPhrases.current, text, performance.now());
      // Tracked so a barge-in mid-phrase can estimate how far into it playback had reached (see
      // pauseForBargeIn/cutSentence); cleared once the phrase finishes playing normally, below.
      currentPhrase.current = { text: text.trim(), startedAt: performance.now(), seconds: expectedSeconds };
      startMeter(analyser, playback);
    };
    const response = await fetch("/api/voice/speech", {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "audio/pcm, audio/wav;q=0.9", ...authHeaders() },
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
    let prepared: PreparedSpeech;
    if (response.body && response.headers.get("content-type")?.startsWith("audio/pcm")) {
      // Streamed: start playing the first words while the rest of the phrase is still being made.
      const sampleRate = Number(response.headers.get("x-sample-rate")) || 24_000;
      prepared = await prepareAudioStream(response.body, sampleRate, context, outputGain.current ?? context.destination, playbackStarted, signal);
      // Refines expectedSeconds (and, if this phrase is already playing, currentPhrase itself)
      // to the stream's real PCM duration once fully received, instead of the rough estimate.
      prepared.completed?.then((seconds) => {
        expectedSeconds = seconds;
        if (currentPhrase.current?.text === text.trim()) currentPhrase.current.seconds = seconds;
      }, () => undefined);
    } else {
      const bytes = await response.arrayBuffer();
      signal.throwIfAborted();
      const buffer = await context.decodeAudioData(bytes);
      signal.throwIfAborted();
      expectedSeconds = buffer.duration;
      prepared = prepareAudioBuffer(
        buffer,
        context,
        outputGain.current ?? context.destination,
        playbackStarted,
      );
    }
    const play = (async (playbackSignal: AbortSignal) => {
      try { await prepared(playbackSignal); }
      finally {
        stopMeter(playback);
        // A phrase that finishes on its own (as opposed to being paused mid-way) leaves nothing
        // to track a barge-in against.
        if (currentPhrase.current?.text === text.trim()) currentPhrase.current = null;
        syncState();
      }
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
    if (audio.current) void synthesizeCues(audio.current);
  };

  const changeVadRedemption = (value: number) => {
    const clamped = writeVadRedemptionMs(value);
    setVadRedemptionMs(clamped);
    // Applies immediately to whichever detector (Silero or the energy fallback) is
    // currently running, without needing to stop and restart the microphone.
    vad.current?.setOptions({ redemptionMs: clamped });
  };

  const resetVoice = () => {
    clearVoicePreference();
    setSavedVoice("");
    setSelectedVoice(profileVoice);
    setVoiceError("");
    setVoiceNotice(`${profileVoice ? friendlyLabel(profileVoice) : "The profile default"} will be used from the next reply.`);
    if (audio.current) void synthesizeCues(audio.current);
  };

  const pauseMicrophoneForSettings = async () => {
    if (!started.current || muted.current || settingsMicPaused.current) return;
    const detector = vad.current;
    if (!detector) return;
    settingsMicPaused.current = true;
    clearAcceptedWatchdog();
    bargeIn.current.reset();
    clearInterruptTimer();
    partialTranscript.current = "";
    partialTranscriptAt.current = 0;
    recentWindow.current = "";
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
    const { prefix } = splitHostKey(liveKey.current);
    if (knownHarness) {
      liveKey.current = `${prefix}${knownHarness}:${id}`;
      return;
    }
    void fetch("/api/sessions", { headers: authHeaders() })
      .then(checkAuthorized)
      .then(async (response) => {
        if (!response.ok) return;
        const result = await response.json() as SessionsResponse;
        const match = result.sessions.find((session) => session.id === id && splitHostKey(session.key).prefix === prefix);
        if (!match) return;
        liveKey.current = match.key;
        harnessRef.current = match.harness;
        if (mounted.current) setSessionDisplay({ harness: match.harness, title: match.title, cwd: match.cwd, host: match.host });
      })
      .catch(() => undefined);
  };

  const sendMessage = async (message: string) => {
    const id = ++generation.current;
    let spoken = false;
    // The phrase right after a tool call gets the early clause boundary again,
    // the same latency break normally reserved for the very first phrase of a turn.
    let earlyAfterTool = false;
    const controller = new AbortController();
    chat.current = controller;
    // The reply gets the speech server to itself; a cue being made is fetched again later.
    cueFetch.current?.abort();
    turnVoice.current = readVoicePreference();
    turnTiming.current = { speechEnd: turnTiming.current.speechEnd, sent: performance.now() };
    updateState("thinking");
    cueState.current = beginTurn(cueState.current);
    lastPipelineActivity.current = Date.now();
    armCueWatcher();
    const noteEnqueued = () => {
      spoken = true;
      earlyAfterTool = false;
      cueState.current = noteSpoken(cueState.current);
      lastPipelineActivity.current = Date.now();
    };
    try {
      if (!message || id !== generation.current) { syncState(); return; }
      assistantAudio.current = "";
      turnVoice.current = readVoicePreference();
      const chatKey = liveKey.current;
      activeChatKey.current = chatKey;
      const response = await fetch(`/api/sessions/${encodeURIComponent(chatKey)}/chat`, {
        method: "POST", headers: { "Content-Type": "application/json", Accept: "text/event-stream", ...authHeaders() },
        body: JSON.stringify({
          conversationId: conversationId.current,
          message,
          ...(folder && splitHostKey(chatKey).inner.startsWith("new:") ? { cwd: folder } : {}),
        }), signal: controller.signal,
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
            syncState();
            setStatusText(event.message);
            return;
          case "tool": {
            harnessTurnActive.current = true;
            syncState();
            setStatusText("");
            toolActivity.push(event);
            lastPipelineActivity.current = Date.now();
            // A tool call must not hold back text that already arrived (e.g. "Let me
            // check that."): flush it now as a final chunk instead of waiting for the
            // sentence to be completed by text that only streams in after the tool runs.
            if (pending.trim()) {
              const flushed = consumeSpeechChunks(pending, true, !spoken || earlyAfterTool);
              pending = flushed.rest;
              if (flushed.chunks.length) {
                noteEnqueued();
                pipeline.current?.enqueue(flushed.chunks);
              }
            }
            earlyAfterTool = true;
            return;
          }
          case "delta": {
            turnTiming.current.firstDelta ??= performance.now();
            if (harnessTurnActive.current) {
              harnessTurnActive.current = false;
              syncState();
            }
            toolActivity.clear();
            pending += event.text;
            const result = consumeSpeechChunks(pending, false, !spoken || earlyAfterTool);
            pending = result.rest;
            if (result.chunks.length) {
              noteEnqueued();
              pipeline.current?.enqueue(result.chunks);
            }
            return;
          }
          case "notice":
            setStatusText(event.message);
            noteEnqueued();
            pipeline.current?.enqueue([event.message]);
            return;
          case "error":
            throw new Error(event.message);
          case "done":
            return;
        }
      });
      if (id === generation.current) {
        const final = consumeSpeechChunks(pending, true, !spoken || earlyAfterTool);
        if (final.chunks.length) {
          noteEnqueued();
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
      if (chat.current === controller) {
        chat.current = null;
        activeChatKey.current = null;
      }
      harnessTurnActive.current = false;
      if (mounted.current) {
        setStatusText("");
        toolActivity.clear();
      }
      if (id === generation.current) {
        cueState.current = endTurn(cueState.current);
        stopCueWatcher();
      }
      syncState();
    }
  };

  const start = async () => {
    if (started.current || starting.current) return;
    starting.current = true;
    const startup = ++startupGeneration.current;
    let context: AudioContext | null = null;
    let microphone: MediaStream | null = null;
    let detector: Detector | null = null;
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
    // How long each startup step takes, reported once voice is listening (durations only).
    const startupAt = performance.now();
    const startupSteps: Record<string, number> = {};
    const markStartup = (name: string) => { startupSteps[name] = Math.round(performance.now() - startupAt); };
    // Set once startup fails, so a lease, microphone or detector that arrives afterwards
    // from a still-running parallel step is released instead of leaking.
    let abandoned = false;
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error("Microphone access requires HTTPS or localhost.");
      setError("");
      setUsingFallbackVad(false);
      updateState("thinking");
      // Created and resumed right in the tap, while the browser still counts it as a user gesture.
      context = new AudioContext();
      const startupContext = context;
      // The lease, the microphone and the Silero model don't depend on each other: run them
      // together, so startup takes as long as the slowest instead of the sum of all three.
      const leaseStep = acquireVoiceOwnership(handleOwnershipLost).then((lease) => {
        if (abandoned) { lease?.release(); return null; }
        acquired = lease;
        markStartup("startup_lease_ms");
        return lease;
      });
      const microphoneStep = navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      }).then((media) => {
        if (abandoned) { media.getTracks().forEach((track) => track.stop()); return null; }
        microphone = media;
        markStartup("startup_microphone_ms");
        return media;
      });
      output = context.createGain();
      output.gain.value = 1;
      output.connect(context.destination);
      nextPipeline = new SpeechPipeline(synthesize, syncState, (caught) => {
        stopMeter();
        report(caught instanceof Error ? caught.message : "Speech playback failed.");
      });
      nextTranscription = new LiveTranscription(transcribe, (text) => {
        partialTranscript.current = text;
        partialTranscriptAt.current = performance.now();
        checkInterrupt(detector, session);
      }, () => endUtteranceEarly(detector, session));
      nextInput = new VoiceInputCoordinator(
        async (recording, signal) => {
          const transcript = await (nextTranscription?.finish(recording.samples, signal) ?? transcribe(recording.samples, signal));
          const stripped = recording.possibleEcho ? removeAssistantEcho(transcript, recording.possibleEcho) : transcript;
          const pending = recording.pendingInterruptDecision;
          const heardWords = stripped.trim() ? stripped.trim().split(/\s+/).length : 0;
          if (!pending) {
            if (bargePaused.current) logVoiceEvent("barge_send_while_paused", { words: heardWords });
            return stripped;
          }
          logVoiceEvent("barge_final_decision", { words: heardWords, blocked: pending.wordPathBlocked });
          // The live preview was empty or stale at speech end, so the interrupt/send
          // decision waited for this, the final transcript (see BargeInGuard.speechEnd).
          const cue = findDeliberateCue(stripped, pending.recentWindow);
          if (cue) {
            interruptActiveTurn();
            return cue.remainder;
          }
          if (!pending.wordPathBlocked && isMeaningfulSpeech(stripped, pending.recentWindow)) {
            interruptActiveTurn();
            return stripped;
          }
          // Not meaningful (or the acoustic gate did not trust the word path): drop it
          // silently, exactly as a fresh-but-unmeaningful preview would have at speech end,
          // and bring the paused reply back (see resumeAfterBargeIn).
          resumeAfterBargeIn();
          return "";
        },
        sendMessage,
        (caught) => report(caught instanceof Error ? caught.message : "Voice transcription failed."),
        syncState,
      );
      // The detector only asks for the stream when it is started, which happens after the
      // microphone step has finished, so it can be built while permission is still pending.
      const currentMicrophone = async () => {
        if (!microphone) throw new Error("The microphone is not ready.");
        return microphone;
      };
      // Both detectors drive this exact same callback contract, so it is
      // built once and shared regardless of which one ends up running.
      const detectorCallbacks = {
        getStream: currentMicrophone, pauseStream: async () => {}, resumeStream: currentMicrophone,
        ...vadOptionsFor(readVadRedemptionMs()),
        submitUserSpeechOnPause: true,
        onSpeechStart: () => {
          if (!isCurrentVad(detector, session)) return;
          input.current?.speechStarted();
          const activeTurn = hasActiveVoiceTurn(Boolean(chat.current), Boolean(pipeline.current?.busy), speaking.current);
          const decision = bargeIn.current.speechStart(activeTurn);
          echoReference.current = speaking.current || pipeline.current?.busy ? assistantAudio.current : "";
          const speechStartAt = performance.now();
          // Captured once, here, and reused for every check against this same candidate
          // (mid-speech and at speech end): what was recently playing when it started.
          recentWindow.current = recentPlaybackWindow(playedPhrases.current, speechStartAt, speechStartAt);
          partialTranscript.current = "";
          partialTranscriptAt.current = 0;
          candidateGateFrames.current = 0;
          candidateGateRmsSum.current = 0;
          candidateGateDecided.current = false;
          if (decision.begin) transcription.current?.begin(activeTurn);
          // No ducking: the mic often hears the reply itself, and dipping on every such blip made the
          // reply's volume pulse. A real interruption stops the reply once words are heard instead.
          armAcceptedWatchdog(detector, session);
          // A candidate that turns into accepted, active-turn speech interrupts the
          // reply once it has run this long, even if the transcript never fills in.
          clearInterruptTimer();
          if (activeTurn) interruptTimer.current = window.setTimeout(() => checkInterrupt(detector, session), meaningfulSpeechMs);
        },
        onSpeechRealStart: () => {
          if (!isCurrentVad(detector, session)) return;
          const decision = bargeIn.current.speechRealStart();
          if (decision.accepted) {
            // Full volume again once speech is confirmed: the mic often hears the reply itself, and
            // holding it quiet until the transcript is judged cut out whole pieces of the reply.
            // It still stops as soon as real words are heard (see checkInterrupt).
            restoreOutput();
            transcription.current?.confirm();
            armAcceptedWatchdog(detector, session);
            // A turn is starting: a cue being made waits until it is over.
            cueFetch.current?.abort();
            setError("");
            updateState("hearing");
          }
        },
        onVADMisfire: () => {
          if (!isCurrentVad(detector, session)) return;
          clearAcceptedWatchdog();
          bargeIn.current.reset();
          clearInterruptTimer();
          partialTranscript.current = "";
          partialTranscriptAt.current = 0;
          echoReference.current = "";
          recentWindow.current = "";
          transcription.current?.discard();
          input.current?.speechDiscarded();
          resumeAfterBargeIn();
          if (!muted.current) syncState();
        },
        onFrameProcessed: (probabilities: { isSpeech: number }, frame: Float32Array) => {
          if (!isCurrentVad(detector, session)) return;
          transcription.current?.frame(probabilities.isSpeech, frame);
          const rms = Math.sqrt(frame.reduce((total, value) => total + value * value, 0) / frame.length);
          setLevel(Math.min(1, rms * 7));
          if (speaking.current && bargeIn.current.idle) {
            // The reply is playing and nothing is being said: this frame's level is
            // (residual) echo, not speech. Folded into a slow-moving floor estimate.
            echoFloor.current = echoFloor.current === null ? rms : echoFloor.current * 0.9 + rms * 0.1;
          } else if (!bargeIn.current.idle && speaking.current && !candidateGateDecided.current) {
            // The first ~250 ms of a candidate that started while the assistant was
            // talking: too quiet next to the echo floor means the mic is probably still
            // just hearing the reply, so this segment cannot interrupt via the word path.
            candidateGateFrames.current++;
            candidateGateRmsSum.current += rms;
            if (candidateGateFrames.current >= acousticGateFrames) {
              candidateGateDecided.current = true;
              const mean = candidateGateRmsSum.current / candidateGateFrames.current;
              if (isBelowEchoFloor(mean, echoFloor.current)) bargeIn.current.blockWordPath();
              // Clearly louder than the reply's own echo: the user is talking, so pause the reply
              // now (~a quarter second in) rather than when the words are transcribed. If they
              // turn out to be a cough or filler, it resumes from where it was cut (see
              // pauseForBargeIn); if not, the turn is aborted and their words are sent instead.
              else if (echoFloor.current !== null) pauseForBargeIn();
            }
          }
        },
        onSpeechEnd: (samples: Float32Array) => {
          if (!isCurrentVad(detector, session)) return;
          turnTiming.current = { speechEnd: performance.now() };
          clearAcceptedWatchdog();
          clearInterruptTimer();
          const freshPreview = (
            partialTranscript.current.trim() !== "" && performance.now() - partialTranscriptAt.current <= previewFreshnessMs
          );
          const decisionWindow = recentWindow.current;
          const decision = bargeIn.current.speechEnd(partialTranscript.current, decisionWindow, freshPreview);
          if (bargePaused.current) {
            logVoiceEvent("barge_speech_end", {
              accepted: decision.accepted, interrupt: Boolean(decision.interrupt), send: Boolean(decision.send),
              deferred: Boolean(decision.deferDecision), fresh: freshPreview,
            });
          }
          partialTranscript.current = "";
          partialTranscriptAt.current = 0;
          if (!decision.accepted) {
            echoReference.current = "";
            recentWindow.current = "";
            transcription.current?.discard();
            input.current?.speechDiscarded();
            resumeAfterBargeIn();
            syncState();
            return;
          }
          if (decision.interrupt) {
            interruptActiveTurn();
          } else if (!decision.deferDecision) {
            // A fresh preview said only filler, echo, or nothing (or this was never a candidate
            // to interrupt at all): bring a paused reply back instead of restarting it - a no-op
            // if pauseForBargeIn never actually paused anything.
            resumeAfterBargeIn();
          }
          // A paused reply stays paused (held) while its fate waits for the final transcript.
          if (!decision.send) {
            // A fresh preview said only filler, echo, or nothing, and the reply was never
            // interrupted: let it keep playing and drop this recording.
            echoReference.current = "";
            recentWindow.current = "";
            transcription.current?.discard();
            input.current?.speechDiscarded();
            syncState();
            return;
          }
          transcription.current?.end(samples);
          const possibleEcho = echoReference.current;
          echoReference.current = "";
          recentWindow.current = "";
          input.current?.speechEnded({
            samples,
            possibleEcho,
            ...(decision.deferDecision
              ? { pendingInterruptDecision: { recentWindow: decisionWindow, wordPathBlocked: decision.wordPathBlocked } }
              : {}),
          });
        },
      };
      // Loading the model does not touch the microphone (`startOnLoad: false`); the module and
      // its assets are usually already cached by the page-load preload.
      const sileroStep: Promise<Detector | null> = sileroInitFailed ? Promise.resolve(null) : (async () => {
        try {
          const { MicVAD } = await loadVadModule();
          const loaded = await MicVAD.new({
            model: "v5", audioContext: startupContext, startOnLoad: false,
            baseAssetPath: voiceAssetBase, onnxWASMBasePath: voiceAssetBase,
            ortConfig: (ort) => { ort.env.wasm.numThreads = 1; },
            ...detectorCallbacks,
          });
          if (abandoned) { void loaded.destroy().catch(() => undefined); return null; }
          detector = loaded;
          markStartup("startup_detector_ms");
          return loaded;
        } catch {
          // Silero/onnxruntime-web cannot recover in-page once it has failed
          // to initialize (e.g. wedged wasm backend after many reloads).
          // Remember that for the rest of the page and go straight to the
          // energy-based fallback on this and every future start().
          sileroInitFailed = true;
          return null;
        }
      })();
      const [lease, activeMicrophone, sileroDetector] = await Promise.all([
        leaseStep, microphoneStep, sileroStep, startupContext.resume(),
      ]);
      // Reassigned here as well so the failure cleanup below sees what the steps produced.
      acquired = lease;
      microphone = activeMicrophone;
      detector = sileroDetector;
      if (!acquired) throw new VoiceOwnershipError();
      if (!activeMicrophone) throw new Error("Voice startup did not finish.");
      ensureCurrentStartup();
      let fallbackActive = false;
      if (!detector) {
        fallbackActive = true;
        detector = await EnergyVad.new({ audioContext: context, ...detectorCallbacks });
        markStartup("startup_detector_ms");
      }
      ensureCurrentStartup();
      // A frame at this level keeps the running detector's segment alive, so it is also
      // what makes a live transcript stale.
      nextTranscription.speechThreshold = fallbackActive ? vadNegativeSpeechThreshold : vadPositiveSpeechThreshold;
      setUsingFallbackVad(fallbackActive);
      await vadTransitions.current.start(detector);
      markStartup("startup_listening_ms");
      ensureCurrentStartup();
      const activeDetector = detector;
      const activeContext = context;
      if (!activeDetector || !activeContext) throw new Error("Voice startup did not finish.");
      ownership.current = acquired;
      audio.current = activeContext;
      outputGain.current = output;
      void synthesizeCues(activeContext);
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
        setUsingFallbackVad(false);
        sessionEpoch.current++;
        clearAcceptedWatchdog();
        vadTransitions.current.deactivate();
        muted.current = false;
        abortTurn();
        restoreOutput();
        bargeIn.current.reset();
        clearInterruptTimer();
        partialTranscript.current = "";
        partialTranscriptAt.current = 0;
        recentWindow.current = "";
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
      // Safari (especially on iPhone) suspends or "interrupts" the audio context after a
      // notification sound, Siri, a call, locking the screen, or an audio route change. Speech
      // detection runs inside it, so without this the page stops hearing while still looking connected.
      let pausedReported = false;
      const keepAudioRunning = () => {
        if (audio.current !== activeContext || !started.current) return;
        if ((activeContext.state as string) === "running" || activeContext.state === "closed") {
          pausedReported = false;
          return;
        }
        void activeContext.resume().catch(() => undefined).then(() => {
          if (audio.current !== activeContext || !started.current || (activeContext.state as string) === "running" || pausedReported) return;
          pausedReported = true;
          report("The device paused audio. Tap the shape to keep talking.");
        });
      };
      activeContext.onstatechange = keepAudioRunning;
      const audioWatch = window.setInterval(() => {
        if (audio.current !== activeContext || activeContext.state === "closed") {
          window.clearInterval(audioWatch);
          document.removeEventListener("visibilitychange", keepAudioRunning);
          return;
        }
        keepAudioRunning();
      }, 2_000);
      document.addEventListener("visibilitychange", keepAudioRunning);
      if (!activeMicrophone.getAudioTracks().some((track) => track.readyState === "live")) {
        handleMicrophoneEnded();
        return;
      }
      updateState("listening");
      void fetch("/api/voice/timing", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify(startupSteps),
      }).catch(() => undefined);
      if (settingsOpenRef.current) void pauseMicrophoneForSettings();
    } catch (caught) {
      abandoned = true;
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

  const isCurrentVad = (candidate: Detector | null, session: number) => (
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

  const ownsCurrentVad = (candidate: Detector | null, expectedMuted: boolean, session?: number) => (
    candidate !== null
    && vad.current === candidate
    && started.current
    && muted.current === expectedMuted
    && (session === undefined || sessionEpoch.current === session)
  );

  const isReadyVadTransition = (candidate: Detector | null, expectedMuted: boolean, session?: number) => (
    ownsCurrentVad(candidate, expectedMuted, session)
    && candidate !== null
    && !vadTransitions.current.isInvalid(candidate)
  );

  const armAcceptedWatchdog = (candidate: Detector | null, session: number) => {
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

  // The live transcript already reads as a finished sentence and the user has paused briefly:
  // end the utterance now with vad-web's pause flush (which delivers onSpeechEnd with the
  // buffered audio) instead of waiting out the whole redemption window.
  const endUtteranceEarly = (candidate: Detector | null, session: number) => {
    if (!candidate || !isCurrentVad(candidate, session)) return;
    void vadTransitions.current.flush(candidate).catch((caught) => {
      if (!ownsCurrentVad(candidate, false, session)) return;
      if (vadTransitions.current.isInvalid(candidate)) {
        deactivateVoice("Microphone transition timed out. Tap the shape to reconnect.");
      } else {
        report(caught instanceof Error ? caught.message : "Microphone recovery failed.");
      }
    });
  };

  // Re-evaluated as new partial transcript text arrives, and once from a timer armed
  // at speech start, so confirmed speech interrupts a reply as soon as it has said
  // something meaningful (not just a quick "um") or has run past the time limit.
  const checkInterrupt = (candidate: Detector | null, session: number) => {
    if (!isCurrentVad(candidate, session)) return;
    if (bargeIn.current.shouldInterruptNow(partialTranscript.current, recentWindow.current)) {
      clearInterruptTimer();
      interruptActiveTurn();
      restoreOutput();
    }
  };

  const toggle = async () => {
    if (!started.current) {
      if (!starting.current) void start();
      return;
    }
    // A tap while the device has paused audio resumes listening rather than muting.
    const context = audio.current;
    if (context && (context.state as string) !== "running" && context.state !== "closed") {
      await context.resume().catch(() => undefined);
      if ((context.state as string) === "running") {
        updateState(muted.current ? "muted" : "listening");
        return;
      }
    }
    // A tap while a reply is running stops it instead of muting, and keeps listening -
    // muting only ever happens from idle/listening, with a second tap needed to mute.
    if (!muted.current && hasActiveVoiceTurn(Boolean(chat.current), Boolean(pipeline.current?.busy), speaking.current)) {
      interruptActiveTurn();
      restoreOutput();
      return;
    }
    muted.current = !muted.current;
    if (muted.current) {
      clearAcceptedWatchdog();
      abortTurn();
      restoreOutput();
      bargeIn.current.reset();
      clearInterruptTimer();
      partialTranscript.current = "";
      partialTranscriptAt.current = 0;
      recentWindow.current = "";
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
    // Before the first tap: load the speech detector and have the agent read the
    // conversation, so neither waits until the user wants to talk.
    preloadVoiceDetector();
    void warmConversation();
  }, [sessionKey]);

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
          setSessionDisplay({ harness: match.harness, title: match.title, cwd: match.cwd, host: match.host });
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
      void fetch("/api/health", { headers: authHeaders() }).then(async (response) => {
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
    clearInterruptTimer();
    partialTranscript.current = "";
    partialTranscriptAt.current = 0;
    recentWindow.current = "";
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

  const replyRunning = hasActiveVoiceTurn(Boolean(chat.current), Boolean(pipeline.current?.busy), speaking.current);
  const label = !started.current
    ? "Start voice conversation"
    : state === "muted" ? "Unmute microphone" : replyRunning ? "Stop reply" : "Mute microphone";
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
      <img className="room-header__logo" src="/logo-192.png" alt="" width={22} height={22} />
      <span className="room-header__title">
        {sessionDisplay.harness ? harnessLabel[sessionDisplay.harness] : "Meldivo"} · {sessionDisplay.title}
      </span>
      {(sessionDisplay.host || sessionDisplay.cwd) && <span className="room-header__cwd">
        {[sessionDisplay.host, sessionDisplay.cwd].filter(Boolean).join(" · ")}
      </span>}
    </header>
    {statusText && <p className="room-status" role="status">{statusText}</p>}
    <ToolActivityStack items={toolActivity.items} />
    {usingFallbackVad && <p className="room-status voice-fallback-notice" role="status">Using basic voice detection</p>}
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
      <label className="voice-settings__label" htmlFor="vad-redemption">
        End-of-speech wait: {vadRedemptionMs} ms
      </label>
      <input
        id="vad-redemption"
        type="range"
        min={vadRedemptionMsMin}
        max={vadRedemptionMsMax}
        step={vadRedemptionMsStep}
        value={vadRedemptionMs}
        onChange={(event) => changeVadRedemption(Number(event.target.value))}
        aria-describedby="vad-redemption-hint"
      />
      <p id="vad-redemption-hint" className="voice-settings__muted">How long to wait after you stop talking before the reply starts. Lower is snappier; higher avoids cutting off pauses.</p>
      <a className="voice-settings__advanced-link" href="/?settings=speech">Speech engines and servers…</a>
    </div>}
    {onboardingOpen && <div className="voice-onboarding" role="dialog" aria-modal="true" aria-labelledby="voice-onboarding-title">
      <div className="voice-onboarding__card">
        <h2 id="voice-onboarding-title">Welcome</h2>
        <p>Tap to talk, or to stop a reply · hold or right-click for settings.</p>
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

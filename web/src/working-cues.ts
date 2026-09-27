/**
 * Short spoken filler cues ("One moment.", …) that fill an otherwise silent
 * gap while a turn is working (e.g. a tool is running) before any real reply
 * text has synthesized audio yet. Kept as a pure, clock-driven state machine
 * so the timing rules are unit-testable without a real audio pipeline; the
 * caller (App.tsx) owns the setInterval, the audio caching, and playback.
 */

export const cuePhrases = [
  "One moment.",
  "Checking now.",
  "Still on it.",
  "Just a second.",
  "Working on it.",
] as const;

/** How long the speech pipeline must have nothing playing or queued before a cue is due. */
export const cueSilenceMs = 1_500;
/** Minimum gap between two cues in the same turn. */
export const cueCooldownMs = 6_000;
/** Cue audio is made this long after listening starts, so it never competes with startup or a quick first turn. */
export const cueSynthesisDelayMs = 4_000;
/** While a turn is under way, cue synthesis re-checks this often whether it may fetch the next cue. */
export const cueIdlePollMs = 500;

export type CueState = {
  turnActive: boolean;
  /** A cue never plays before the turn's first real spoken word, so it can't add startup latency. */
  hasSpokenThisTurn: boolean;
  lastCueAt: number | null;
  lastCueText: string | null;
};

export function freshCueState(): CueState {
  return { turnActive: false, hasSpokenThisTurn: false, lastCueAt: null, lastCueText: null };
}

/** A new turn starts silent and un-cued, even if the previous turn had spoken. */
export function beginTurn(_state: CueState): CueState {
  return { turnActive: true, hasSpokenThisTurn: false, lastCueAt: null, lastCueText: null };
}

/** The turn ended or was interrupted: no further cues belong to it. */
export function endTurn(state: CueState): CueState {
  return { ...state, turnActive: false };
}

/** Real spoken text has reached the speech pipeline at least once this turn. */
export function noteSpoken(state: CueState): CueState {
  return state.hasSpokenThisTurn ? state : { ...state, hasSpokenThisTurn: true };
}

export function noteCuePlayed(state: CueState, text: string, now: number): CueState {
  return { ...state, lastCueAt: now, lastCueText: text };
}

/**
 * Whether a cue should start now, given how long the speech pipeline has had
 * nothing playing or queued (`silentForMs`, measured by the caller from the
 * last time it enqueued real speech or saw a tool event).
 */
export function dueForCue(state: CueState, silentForMs: number, now: number): boolean {
  if (!state.turnActive || !state.hasSpokenThisTurn) return false;
  if (silentForMs < cueSilenceMs) return false;
  if (state.lastCueAt !== null && now - state.lastCueAt < cueCooldownMs) return false;
  return true;
}

/** Picks a cue different from the one just played, when more than one option exists. */
export function pickCue(state: CueState, random: () => number = Math.random): string {
  const options = state.lastCueText ? cuePhrases.filter((phrase) => phrase !== state.lastCueText) : cuePhrases;
  const pool = options.length ? options : cuePhrases;
  return pool[Math.min(pool.length - 1, Math.floor(random() * pool.length))]!;
}

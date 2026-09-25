function plainSpeech(text: string) {
  return text
    .replace(/```[\s\S]*?(?:```|$)/g, " Code is shown on screen. ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/[*_`#>|]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// A slow (e.g. CPU) TTS backend makes the very first spoken unit of a turn
// the dominant contributor to perceived latency: nothing is audible until it
// is fully synthesized. So the first chunk of a turn is allowed to end at a
// clause boundary (comma/semicolon/colon) or a short word-count cap, instead
// of waiting for a full sentence like every later chunk does. Later chunks
// keep the sentence-level boundary because SpeechPipeline coalesces them
// into larger TTS requests anyway once the first phrase is already playing.
function speechBoundary(text: string, early: boolean): number {
  let fence = false;
  let inline = false;
  let brackets = 0;
  let link = false;
  for (let index = 0; index < text.length; index++) {
    if (text.startsWith("```", index)) {
      fence = !fence;
      index += 2;
      continue;
    }
    if (fence) continue;
    if (text[index] === "`") {
      inline = !inline;
      continue;
    }
    if (inline) continue;
    if (text[index] === "[") brackets++;
    if (text[index] === "]") {
      brackets = Math.max(0, brackets - 1);
      if (text[index + 1] === "(") link = true;
    }
    if (link) {
      if (text[index] === ")") link = false;
      continue;
    }
    if (brackets) continue;

    const punctuation = /[.!?。！？]/.test(text[index]) || (early && /[,;:，；：]/.test(text[index]));
    const boundary = punctuation && (/[。！？，；：]/.test(text[index]) || /\s/.test(text[index + 1] || ""));
    const abbreviation = text[index] === "." && /(?:\b(?:Mr|Mrs|Ms|Dr|Prof|St|vs|etc)|\b[A-Za-z])\.$/i.test(text.slice(0, index + 1));
    const lengthCap = early ? 48 : 160;
    if ((boundary && !abbreviation) || text[index] === "\n" || text[index] === "—" || (index >= lengthCap && /\s/.test(text[index]))) {
      return index + 1;
    }
  }
  return 0;
}

function phraseBoundary(text: string, done: boolean, early: boolean): number {
  let end = 0;
  while (end < text.length) {
    const boundary = speechBoundary(text.slice(end), early) || (done ? text.length - end : 0);
    if (!boundary) return 0;
    end += boundary;
    const words = plainSpeech(text.slice(0, end).replace(/—/g, " ")).match(/[\p{L}\p{N}]+(?:['’\-][\p{L}\p{N}]+)*/gu)?.length ?? 0;
    const minWords = early ? 5 : 3;
    if (words > minWords || (done && end === text.length)) return end;
  }
  return 0;
}

/**
 * Consume stable phrase boundaries once and retain the unfinished tail.
 * When `first` is set, the earliest chunk in this call is allowed to break
 * at a short clause (≈6-10 words) so the first sentence reaches TTS as soon
 * as possible; every chunk after that reverts to full-sentence boundaries.
 */
export function consumeSpeechChunks(text: string, done = false, first = false) {
  const chunks: string[] = [];
  let offset = 0;
  let early = first;
  while (offset < text.length) {
    const end = phraseBoundary(text.slice(offset), done, early);
    if (!end) break;
    const spoken = plainSpeech(text.slice(offset, offset + end).replace(/—$/, "").replace(/—/g, ", "));
    if (spoken) {
      chunks.push(spoken);
      early = false;
    }
    offset += end;
  }
  return { chunks, rest: done ? "" : text.slice(offset) };
}

/** A confirmed user turn must never wait for assistant speech to finish. */
export function hasActiveVoiceTurn(chatActive: boolean, pipelineBusy: boolean, speaking: boolean) {
  return chatActive || pipelineBusy || speaking;
}

/** Silero emits mono 16 kHz Float32 samples ready for Whisper. */
export function samplesWav(samples: Float32Array) {
  const bytes = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(bytes);
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 16_000, true);
  view.setUint32(28, 32_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, index) => view.setInt16(44 + index * 2, Math.max(-1, Math.min(1, sample)) * (sample < 0 ? 32_768 : 32_767), true));
  return new Blob([bytes], { type: "audio/wav" });
}

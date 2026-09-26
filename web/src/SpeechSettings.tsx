import { useEffect, useRef, useState } from "react";
import { authHeaders, checkAuthorized, UnauthorizedError } from "./auth";

// Hub-wide speech engines: the on-device models, or a speech server for either direction.
// Picking an engine and typing its address loads that server's models and speakers.

type Kind = "tts" | "stt";
type EngineInfo = { id: string; label: string; note?: string; defaultUrl?: string; hasModels: boolean };
type Setting = { engine: string; url?: string; model?: string; voice?: string; hasKey?: boolean };
type SettingsResponse = Record<Kind, { engines: EngineInfo[]; setting: Setting }>;
type ModelOption = { id: string; installed?: boolean };
type Discovery = { models: ModelOption[]; voices: string[]; model?: string; voice?: string };

type Draft = {
  engine: string;
  url: string;
  apiKey: string;
  hasKey: boolean;
  clearKey: boolean;
  model: string;
  voice: string;
  models: ModelOption[];
  voices: string[];
  status: "idle" | "loading" | "ready" | "error";
  error: string;
};

function draftFrom(setting: Setting): Draft {
  return {
    engine: setting.engine,
    url: setting.url ?? "",
    apiKey: "",
    hasKey: Boolean(setting.hasKey),
    clearKey: false,
    model: setting.model ?? "",
    voice: setting.voice ?? "",
    models: [],
    voices: [],
    status: "idle",
    error: "",
  };
}

function settingBody(draft: Draft) {
  if (draft.engine === "local") return { engine: "local", ...(draft.voice ? { voice: draft.voice } : {}) };
  return {
    engine: draft.engine,
    url: draft.url,
    ...(draft.apiKey ? { apiKey: draft.apiKey } : {}),
    ...(draft.clearKey ? { clearKey: true } : {}),
    ...(draft.model ? { model: draft.model } : {}),
    ...(draft.voice ? { voice: draft.voice } : {}),
  };
}

export function voiceLabel(voice: string): string {
  const kokoro = /^([abefhijpz])([fm])_(.+)$/.exec(voice);
  const name = (kokoro ? kokoro[3]! : voice.replace(/\.(wav|mp3|flac)$/i, "")).replace(/[_-]+/g, " ").trim();
  const titled = name.replace(/\b\w/g, (letter) => letter.toUpperCase());
  if (!kokoro) return titled;
  const accent: Record<string, string> = { a: "American", b: "British", e: "Spanish", f: "French", h: "Hindi", i: "Italian", j: "Japanese", p: "Portuguese", z: "Chinese" };
  return `${titled} (${accent[kokoro[1]!] ?? ""} ${kokoro[2] === "f" ? "female" : "male"})`.replace("( ", "(");
}

async function postJson<T>(url: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const response = checkAuthorized(await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
    signal,
  }));
  const result = await response.json().catch(() => ({})) as T & { error?: string };
  if (!response.ok) throw new Error(result.error ?? "The request failed.");
  return result;
}

function EngineSection({ kind, engines, draft, onChange }: { kind: Kind; engines: EngineInfo[]; draft: Draft; onChange: (update: (draft: Draft) => Draft) => void }) {
  const engine = engines.find((entry) => entry.id === draft.engine);
  const remote = draft.engine !== "local";
  const [previewing, setPreviewing] = useState(false);
  const previewAbort = useRef<AbortController | null>(null);
  const previewContext = useRef<AudioContext | null>(null);
  const discoverAbort = useRef<AbortController | null>(null);
  const title = kind === "tts" ? "Text to speech" : "Speech to text";
  const idPrefix = `speech-${kind}`;

  // Load models and speakers whenever the engine, address, key, or (for speakers) model changes.
  const modelForVoices = kind === "tts" ? draft.model : "";
  useEffect(() => {
    discoverAbort.current?.abort();
    if (remote && !draft.url.trim()) {
      onChange((d) => ({ ...d, models: [], voices: [], status: "idle", error: "" }));
      return;
    }
    const controller = new AbortController();
    discoverAbort.current = controller;
    const timer = window.setTimeout(() => {
      onChange((d) => ({ ...d, status: "loading", error: "" }));
      const setting = { ...settingBody({ ...draft, voice: "" }) };
      void postJson<Discovery>("/api/speech/discover", { kind, setting }, controller.signal)
        .then((found) => {
          if (controller.signal.aborted) return;
          onChange((d) => {
            const model = found.models.some((m) => m.id === d.model) ? d.model : found.model ?? found.models[0]?.id ?? "";
            const voice = found.voices.includes(d.voice) ? d.voice : found.voice ?? found.voices[0] ?? "";
            return { ...d, models: found.models, voices: found.voices, model, voice, status: "ready", error: "" };
          });
        })
        .catch((caught) => {
          if (caught instanceof UnauthorizedError) throw caught;
          if (controller.signal.aborted) return;
          onChange((d) => ({ ...d, models: [], voices: [], status: "error", error: caught instanceof Error ? caught.message : "Could not reach the server." }));
        });
    }, remote ? 600 : 0);
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [kind, draft.engine, draft.url, draft.apiKey, draft.clearKey, modelForVoices]);

  const stopPreview = () => {
    previewAbort.current?.abort();
    const context = previewContext.current;
    previewContext.current = null;
    if (context && context.state !== "closed") void context.close().catch(() => undefined);
  };

  useEffect(() => stopPreview, []);

  const preview = async () => {
    if (!draft.voice) return;
    stopPreview();
    const controller = new AbortController();
    previewAbort.current = controller;
    // Created inside the tap so iOS Safari lets it play once the audio arrives.
    const context = new AudioContext();
    previewContext.current = context;
    setPreviewing(true);
    onChange((d) => ({ ...d, error: "" }));
    try {
      const response = checkAuthorized(await fetch("/api/speech/preview", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...authHeaders() },
        body: JSON.stringify({ setting: settingBody(draft), voice: draft.voice }),
        signal: controller.signal,
      }));
      if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Preview failed.");
      await context.resume();
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      if (controller.signal.aborted) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      source.onended = () => {
        if (previewContext.current !== context) return;
        stopPreview();
        setPreviewing(false);
      };
      source.start();
    } catch (caught) {
      if (caught instanceof UnauthorizedError) throw caught;
      if (!controller.signal.aborted) {
        stopPreview();
        setPreviewing(false);
        onChange((d) => ({ ...d, error: caught instanceof Error ? caught.message : "Preview failed." }));
      }
    }
  };

  return <section className="speech-section" aria-labelledby={`${idPrefix}-title`}>
    <h3 id={`${idPrefix}-title`}>{title}</h3>
    <label className="speech-field">
      <span>Engine</span>
      <select value={draft.engine} onChange={(event) => {
        const next = event.target.value;
        onChange((d) => ({ ...draftFrom({ engine: next }), url: next === d.engine ? d.url : "" }));
      }}>
        {engines.map((entry) => <option key={entry.id} value={entry.id}>{entry.label}{entry.note ? ` · ${entry.note}` : ""}</option>)}
      </select>
    </label>
    {remote && <>
      <label className="speech-field">
        <span>Server address</span>
        <input
          type="url"
          inputMode="url"
          autoComplete="off"
          spellCheck={false}
          placeholder={engine?.defaultUrl ?? "http://localhost:8000"}
          value={draft.url}
          onChange={(event) => { const url = event.target.value; onChange((d) => ({ ...d, url })); }}
        />
      </label>
      <label className="speech-field">
        <span>API key <em>(optional)</em></span>
        <input
          type="password"
          autoComplete="off"
          placeholder={draft.hasKey && !draft.clearKey ? "Saved; type to replace" : "Leave empty if the server has none"}
          value={draft.apiKey}
          onChange={(event) => { const apiKey = event.target.value; onChange((d) => ({ ...d, apiKey, clearKey: false })); }}
        />
      </label>
      {draft.hasKey && !draft.apiKey && !draft.clearKey && <button type="button" className="speech-link" onClick={() => onChange((d) => ({ ...d, clearKey: true }))}>Remove saved key</button>}
    </>}
    {draft.status === "loading" && <p className="speech-status">Connecting…</p>}
    {draft.status === "ready" && remote && <p className="speech-status speech-status--ok">Connected</p>}
    {draft.status === "error" && <p className="speech-status speech-status--error" role="alert">{draft.error}</p>}
    {remote && draft.models.length > 0 && (engine?.hasModels || draft.models.length > 1) && <label className="speech-field">
      <span>Model</span>
      <select value={draft.model} onChange={(event) => { const model = event.target.value; onChange((d) => ({ ...d, model })); }}>
        {draft.models.map((model) => <option key={model.id} value={model.id}>{model.id}{model.installed === false ? " (downloads on first use)" : ""}</option>)}
      </select>
    </label>}
    {kind === "tts" && draft.voices.length > 0 && <div className="speech-field">
      <label htmlFor={`${idPrefix}-voice`}>Speaker</label>
      <div className="speech-voice">
        <select id={`${idPrefix}-voice`} value={draft.voice} onChange={(event) => { const voice = event.target.value; onChange((d) => ({ ...d, voice })); }}>
          {draft.voices.map((voice) => <option key={voice} value={voice}>{voiceLabel(voice)}</option>)}
        </select>
        <button type="button" className="speech-play" onClick={() => { void preview(); }} disabled={!draft.voice || previewing} aria-label={`Play a preview of ${draft.voice ? voiceLabel(draft.voice) : "this speaker"}`}>
          {previewing ? "…" : "▶"}
        </button>
      </div>
    </div>}
    {draft.error && draft.status !== "error" && <p className="speech-status speech-status--error" role="alert">{draft.error}</p>}
  </section>;
}

export function SpeechSettingsPanel({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<SettingsResponse | null>(null);
  const [tts, setTts] = useState<Draft | null>(null);
  const [stt, setStt] = useState<Draft | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void fetch("/api/speech/settings", { headers: authHeaders() })
      .then(checkAuthorized)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load the speech settings.");
        const result = await response.json() as SettingsResponse;
        setLoaded(result);
        setTts(draftFrom(result.tts.setting));
        setStt(draftFrom(result.stt.setting));
      })
      .catch((caught) => {
        if (caught instanceof UnauthorizedError) throw caught;
        setError(caught instanceof Error ? caught.message : "Could not load the speech settings.");
      });
  }, []);

  const update = (setter: typeof setTts) => (change: (draft: Draft) => Draft) => {
    setNotice("");
    setter((draft) => (draft ? change(draft) : draft));
  };

  const save = () => {
    if (!tts || !stt) return;
    setSaving(true);
    setError("");
    setNotice("");
    void fetch("/api/speech/settings", {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ tts: settingBody(tts), stt: settingBody(stt) }),
    })
      .then(checkAuthorized)
      .then(async (response) => {
        const result = await response.json().catch(() => ({})) as SettingsResponse & { error?: string };
        if (!response.ok) throw new Error(result.error ?? "Could not save the speech settings.");
        setTts((draft) => draft && { ...draft, apiKey: "", clearKey: false, hasKey: Boolean(result.tts.setting.hasKey) });
        setStt((draft) => draft && { ...draft, apiKey: "", clearKey: false, hasKey: Boolean(result.stt.setting.hasKey) });
        setNotice("Saved. Every machine and browser on this hub uses it from the next turn.");
      })
      .catch((caught) => {
        if (caught instanceof UnauthorizedError) throw caught;
        setError(caught instanceof Error ? caught.message : "Could not save the speech settings.");
      })
      .finally(() => setSaving(false));
  };

  const incomplete = (draft: Draft | null) => !draft || (draft.engine !== "local" && !draft.url.trim());

  return <div className="hub-remote speech-settings" role="dialog" aria-labelledby="speech-settings-title">
    <div className="hub-remote__header">
      <h2 id="speech-settings-title">Speech</h2>
      <button className="hub-remote__close" type="button" onClick={onClose} aria-label="Close speech settings">×</button>
    </div>
    <p className="hub-muted speech-intro">Use the built-in on-device models, or point either direction at a speech server you run, for a bigger, more realistic, or faster model.</p>
    {!loaded && !error && <p className="hub-muted">Loading…</p>}
    {loaded && tts && stt && <>
      <EngineSection kind="tts" engines={loaded.tts.engines} draft={tts} onChange={update(setTts)} />
      <EngineSection kind="stt" engines={loaded.stt.engines} draft={stt} onChange={update(setStt)} />
      <div className="speech-actions">
        <button type="button" className="hub-primary" onClick={save} disabled={saving || incomplete(tts) || incomplete(stt)}>{saving ? "Saving…" : "Save"}</button>
      </div>
    </>}
    {error && <p className="hub-error" role="alert">{error}</p>}
    {notice && <p className="speech-status speech-status--ok" role="status">{notice}</p>}
  </div>;
}

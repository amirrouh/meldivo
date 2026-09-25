import { useEffect, useRef, useState } from "react";
import { authHeaders, checkAuthorized, UnauthorizedError } from "./auth";
import { UnauthorizedScreen } from "./UnauthorizedScreen";
import { harnessLabel, harnessOrder, type HarnessDescriptor, type SessionInfo, type SessionsResponse } from "./session-types";

const sessionsPollMs = 5_000;
const healthPollMs = 5_000;

type SpeechHealth = { ready: boolean; downloading: boolean; progress?: number; error?: string };
type HealthResponse = { ok?: unknown; speech?: { ready?: unknown; downloading?: unknown; progress?: unknown; error?: unknown } };
type RemoteOption = { id: string; label: string; ready: boolean };
type RemoteState = { options: RemoteOption[]; active: { id: string; url: string } | null; guide?: string };

function shortenCwd(cwd: string): string {
  const home = /^(\/home\/[^/]+|\/Users\/[^/]+)(\/.*)?$/.exec(cwd);
  if (!home) return cwd;
  return home[2] ? `~${home[2]}` : "~";
}

function relativeTime(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return `${days}d ago`;
}

function openSession(key: string) {
  window.location.href = `/?session=${encodeURIComponent(key)}`;
}

function harnessTile(harness: HarnessDescriptor) {
  const description = harness.id === "pi" ? "New chat in your home folder" : "New chat in your home folder";
  return (
    <button
      key={harness.id}
      type="button"
      className="hub-tile"
      disabled={!harness.available}
      onClick={() => openSession(`new:${harness.id}`)}
    >
      <span className="hub-tile__label">{harness.label}</span>
      <span className="hub-tile__desc">{harness.available ? description : "not installed"}</span>
    </button>
  );
}

function stateDot(session: SessionInfo): { className: string; label: string } {
  if (session.busy) return { className: "hub-dot hub-dot--busy", label: "busy" };
  if (session.open) return { className: "hub-dot hub-dot--open", label: "open in terminal" };
  return { className: "hub-dot hub-dot--idle", label: "idle" };
}

function RemotePanel({ onClose }: { onClose: () => void }) {
  const [remote, setRemote] = useState<RemoteState | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [qrDataUrl, setQrDataUrl] = useState("");

  const load = () => {
    setError("");
    void fetch("/api/remote", { headers: authHeaders() })
      .then(checkAuthorized)
      .then(async (response) => {
        if (!response.ok) throw new Error("Could not load phone access options.");
        setRemote(await response.json() as RemoteState);
      })
      .catch((caught) => {
        if (caught instanceof UnauthorizedError) throw caught;
        setError(caught instanceof Error ? caught.message : "Could not load phone access options.");
      });
  };

  useEffect(load, []);

  useEffect(() => {
    const url = remote?.active?.url;
    if (!url) {
      setQrDataUrl("");
      return;
    }
    let cancelled = false;
    void import("qrcode").then(async (QRCode) => {
      const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 200 });
      if (!cancelled) setQrDataUrl(dataUrl);
    }).catch(() => { if (!cancelled) setQrDataUrl(""); });
    return () => { cancelled = true; };
  }, [remote?.active?.url]);

  const select = (id: string) => {
    setBusy(true);
    setError("");
    void fetch("/api/remote", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ id }),
    })
      .then(checkAuthorized)
      .then(async (response) => {
        if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? "Could not enable phone access.");
        load();
      })
      .catch((caught) => {
        if (caught instanceof UnauthorizedError) throw caught;
        setError(caught instanceof Error ? caught.message : "Could not enable phone access.");
      })
      .finally(() => setBusy(false));
  };

  const turnOff = () => {
    setBusy(true);
    setError("");
    void fetch("/api/remote", { method: "DELETE", headers: authHeaders() })
      .then(checkAuthorized)
      .then((response) => {
        if (!response.ok) throw new Error("Could not turn off phone access.");
        load();
      })
      .catch((caught) => {
        if (caught instanceof UnauthorizedError) throw caught;
        setError(caught instanceof Error ? caught.message : "Could not turn off phone access.");
      })
      .finally(() => setBusy(false));
  };

  return (
    <div className="hub-remote" role="dialog" aria-labelledby="hub-remote-title">
      <div className="hub-remote__header">
        <h2 id="hub-remote-title">Phone access</h2>
        <button className="hub-remote__close" type="button" onClick={onClose} aria-label="Close phone access">×</button>
      </div>
      {!remote && !error && <p className="hub-muted">Loading…</p>}
      {error && <p className="hub-error" role="alert">{error}</p>}
      {remote?.active && (
        <div className="hub-remote__active">
          <p className="hub-remote__url">{remote.active.url}</p>
          {qrDataUrl && <img className="hub-remote__qr" src={qrDataUrl} alt="QR code for phone access URL" />}
          <button type="button" onClick={turnOff} disabled={busy}>Turn off</button>
        </div>
      )}
      {remote && !remote.active && (
        <>
          <ul className="hub-remote__options">
            {remote.options.map((option) => (
              <li key={option.id}>
                <button type="button" disabled={!option.ready || busy} onClick={() => select(option.id)}>
                  {option.label}{!option.ready ? " (not ready)" : ""}
                </button>
              </li>
            ))}
          </ul>
          {!remote.options.some((option) => option.ready) && remote.guide && (
            /^https?:\/\//.test(remote.guide)
              ? <p className="hub-muted"><a href={remote.guide} target="_blank" rel="noreferrer">Set up phone access</a></p>
              : <p className="hub-muted">{remote.guide}</p>
          )}
        </>
      )}
    </div>
  );
}

export default function Hub() {
  const [data, setData] = useState<SessionsResponse | null>(null);
  const [error, setError] = useState("");
  const [unauthorized, setUnauthorized] = useState(false);
  const [speechHealth, setSpeechHealth] = useState<SpeechHealth>({ ready: true, downloading: false });
  const [remoteOpen, setRemoteOpen] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    const poll = () => {
      void fetch("/api/sessions", { headers: authHeaders() })
        .then(checkAuthorized)
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not load sessions.");
          const result = await response.json() as SessionsResponse;
          if (!cancelled) {
            setData(result);
            setError("");
          }
        })
        .catch((caught) => {
          if (cancelled) return;
          if (caught instanceof UnauthorizedError) {
            setUnauthorized(true);
            return;
          }
          setError(caught instanceof Error ? caught.message : "Could not load sessions.");
        });
    };
    poll();
    const interval = window.setInterval(poll, sessionsPollMs);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

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

  if (unauthorized) return <UnauthorizedScreen />;

  const harnesses = [...(data?.harnesses ?? [])].sort(
    (a, b) => harnessOrder.indexOf(a.id) - harnessOrder.indexOf(b.id),
  );
  const sessions = data?.sessions ?? [];
  const groups = new Map<string, SessionInfo[]>();
  for (const session of sessions) {
    const list = groups.get(session.cwd) ?? [];
    list.push(session);
    groups.set(session.cwd, list);
  }
  const groupEntries = [...groups.entries()].sort(
    (a, b) => Math.max(...b[1].map((s) => s.updatedAt)) - Math.max(...a[1].map((s) => s.updatedAt)),
  );
  const speechStatusLabel = speechHealth.ready
    ? "Speech ready"
    : speechHealth.downloading
      ? `Downloading voice models…${typeof speechHealth.progress === "number" ? ` ${Math.round(speechHealth.progress)}%` : ""}`
      : "Speech offline";

  return (
    <main className="hub-page">
      <header className="hub-header">
        <h1>{data?.machine ?? "Meldivo"}</h1>
        <p className={`hub-speech-status${speechHealth.ready ? "" : " hub-speech-status--warn"}`} role="status">
          {speechHealth.error || speechStatusLabel}
        </p>
        <button type="button" className="hub-remote-button" onClick={() => setRemoteOpen(true)}>Phone access</button>
      </header>

      {error && <p className="hub-error" role="alert">{error}</p>}

      <section className="hub-section">
        <h2>Start a conversation</h2>
        <div className="hub-tiles">
          {harnesses.map(harnessTile)}
          {harnesses.length === 0 && <p className="hub-muted">No harnesses detected on this machine.</p>}
        </div>
      </section>

      <section className="hub-section">
        <h2>Sessions</h2>
        {sessions.length === 0 && <p className="hub-muted">No sessions yet. Tap a tile above to start one.</p>}
        {groupEntries.map(([cwd, group]) => (
          <div key={cwd} className="hub-group">
            <h3 className="hub-group__title">{shortenCwd(cwd)}</h3>
            <ul className="hub-sessions">
              {group.sort((a, b) => b.updatedAt - a.updatedAt).map((session) => {
                const dot = stateDot(session);
                return (
                  <li key={session.key}>
                    <button type="button" className="hub-session" onClick={() => openSession(session.key)}>
                      <span className={dot.className} aria-hidden="true" title={dot.label} />
                      <span className="hub-session__body">
                        <span className="hub-session__title">{session.title}</span>
                        <span className="hub-session__meta">
                          <span className="hub-session__badge">{harnessLabel[session.harness]}</span>
                          <span>{relativeTime(session.updatedAt)}</span>
                        </span>
                        {session.open && <span className="hub-session__hint">continues as a voice copy</span>}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </section>

      {remoteOpen && <RemotePanel onClose={() => setRemoteOpen(false)} />}
    </main>
  );
}

import { useEffect, useRef, useState } from "react";
import { authHeaders, checkAuthorized, UnauthorizedError } from "./auth";
import { UnauthorizedScreen } from "./UnauthorizedScreen";
import { harnessLabel, harnessOrder, type HostInfo, type SessionInfo, type SessionsResponse } from "./session-types";

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

const selectedMachineKey = "meldivo.machine";
const pageSize = 40;

function hostKeyPrefix(host: HostInfo): string {
  return host.id ? `@${host.id}/` : "";
}

function MachineCard({ host, sessions, selected, onSelect }: { host: HostInfo; sessions: SessionInfo[]; selected: boolean; onSelect: () => void }) {
  const open = sessions.filter((session) => session.open).length;
  const busy = sessions.some((session) => session.busy);
  const latest = sessions.reduce((max, session) => Math.max(max, session.updatedAt), 0);
  const dot = !host.online ? "hub-dot--idle" : busy ? "hub-dot--busy" : "hub-dot--online";
  return (
    <button type="button" role="tab" aria-selected={selected} className={`hub-machine${selected ? " hub-machine--selected" : ""}${host.online ? "" : " hub-machine--offline"}`} onClick={onSelect}>
      <span className="hub-machine__name"><span className={`hub-dot ${dot}`} aria-hidden="true" />{host.name}</span>
      <span className="hub-machine__meta">
        {host.online
          ? <>{sessions.length} session{sessions.length === 1 ? "" : "s"}{open > 0 && <> · {open} open</>}</>
          : "offline"}
      </span>
      {host.online && latest > 0 && <span className="hub-machine__meta">active {relativeTime(latest)}</span>}
    </button>
  );
}

function MachinePanel({ host, sessions }: { host: HostInfo; sessions: SessionInfo[] }) {
  const [query, setQuery] = useState("");
  const [openOnly, setOpenOnly] = useState(false);
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => { setQuery(""); setOpenOnly(false); setLimit(pageSize); }, [host.id]);

  if (!host.online) {
    return <p className="hub-empty">{host.name} is offline. Its sessions appear here as soon as it reconnects.</p>;
  }

  const prefix = hostKeyPrefix(host);
  const harnesses = [...host.harnesses].sort((a, b) => harnessOrder.indexOf(a.id) - harnessOrder.indexOf(b.id));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sessions
    .filter((session) => !openOnly || session.open)
    .filter((session) => {
      if (terms.length === 0) return true;
      const haystack = `${session.title} ${shortenCwd(session.cwd)} ${harnessLabel[session.harness]}`.toLowerCase();
      return terms.every((term) => haystack.includes(term));
    })
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const openCount = sessions.filter((session) => session.open).length;

  return (
    <div className="hub-panel" role="tabpanel">
      <div className="hub-new" aria-label="Start a new chat">
        {harnesses.map((harness) => (
          <button key={harness.id} type="button" className="hub-new__button" disabled={!harness.available}
            title={harness.available ? "New chat in the home folder" : "Not installed"}
            aria-label={`New ${harness.label} chat`}
            onClick={() => openSession(`${prefix}new:${harness.id}`)}>
            <span aria-hidden="true">+ </span>{harness.label}
          </button>
        ))}
        {harnesses.length === 0 && <span className="hub-muted">No coding agents on this machine.</span>}
      </div>

      {sessions.length > 0 && (
        <div className="hub-search">
          <input type="search" className="hub-search__input" placeholder={`Search ${sessions.length} sessions`} value={query}
            onChange={(event) => { setQuery(event.target.value); setLimit(pageSize); }} aria-label="Search sessions" autoComplete="off" />
          <button type="button" className={`hub-chip${openOnly ? " hub-chip--on" : ""}`} aria-pressed={openOnly}
            onClick={() => { setOpenOnly(!openOnly); setLimit(pageSize); }} disabled={openCount === 0 && !openOnly}>
            Open now{openCount > 0 ? ` ${openCount}` : ""}
          </button>
        </div>
      )}

      {sessions.length === 0 && <p className="hub-empty">No sessions yet. Start a new chat above.</p>}
      {sessions.length > 0 && matches.length === 0 && <p className="hub-empty">No sessions match.</p>}
      <ul className="hub-sessions">
        {matches.slice(0, limit).map((session) => {
          const dot = stateDot(session);
          return (
            <li key={session.key}>
              <button type="button" className="hub-session" onClick={() => openSession(session.key)}>
                <span className={dot.className} aria-hidden="true" title={dot.label} />
                <span className="hub-session__body">
                  <span className="hub-session__title">{session.title || "(untitled)"}</span>
                  <span className="hub-session__meta">
                    <span className="hub-session__badge">{harnessLabel[session.harness]}</span>
                    <span className="hub-session__cwd">{shortenCwd(session.cwd)}</span>
                    <span className="hub-session__time">{relativeTime(session.updatedAt)}</span>
                  </span>
                  {session.open && <span className="hub-session__hint">open in a terminal · continues as a voice copy</span>}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
      {matches.length > limit && (
        <button type="button" className="hub-more" onClick={() => setLimit(limit + pageSize)}>
          Show more ({matches.length - limit})
        </button>
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
  const [selectedId, setSelectedId] = useState<string | null>(() => {
    try { return window.localStorage.getItem(selectedMachineKey); } catch { return null; }
  });
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

  const allHosts: HostInfo[] = data?.hosts ?? (data ? [{ id: "", name: data.machine, online: true, harnesses: data.harnesses }] : []);
  const allSessions = data?.sessions ?? [];
  const sessionsOf = (host: HostInfo) => allSessions.filter((session) => (session.host ?? "") === host.id);
  // A hub with no agents of its own (e.g. a small always-on box) only lists the machines that joined it.
  const hosts = allHosts.filter((host) => host.id !== "" || allHosts.length === 1
    || host.harnesses.some((harness) => harness.available) || sessionsOf(host).length > 0);
  const selected = hosts.find((host) => host.id === selectedId) ?? hosts.find((host) => host.online) ?? hosts[0];
  const select = (id: string) => {
    setSelectedId(id);
    try { window.localStorage.setItem(selectedMachineKey, id); } catch { /* storage may be unavailable */ }
  };
  const speechStatusLabel = speechHealth.ready
    ? "Speech ready"
    : speechHealth.downloading
      ? `Downloading voice models…${typeof speechHealth.progress === "number" ? ` ${Math.round(speechHealth.progress)}%` : ""}`
      : "Speech offline";

  return (
    <main className="hub-page">
      <header className="hub-header">
        <h1>{hosts.length > 1 ? "Meldivo" : data?.machine ?? "Meldivo"}</h1>
        <p className={`hub-speech-status${speechHealth.ready ? "" : " hub-speech-status--warn"}`} role="status">
          {speechHealth.error || speechStatusLabel}
        </p>
        <button type="button" className="hub-remote-button" onClick={() => setRemoteOpen(true)}>Phone access</button>
      </header>

      {error && <p className="hub-error" role="alert">{error}</p>}
      {!data && !error && <p className="hub-empty">Loading…</p>}

      {hosts.length > 1 && (
        <nav className="hub-machines" role="tablist" aria-label="Machines">
          {hosts.map((host) => (
            <MachineCard key={host.id || "local"} host={host} sessions={sessionsOf(host)} selected={host === selected} onSelect={() => select(host.id)} />
          ))}
        </nav>
      )}

      {selected && <MachinePanel host={selected} sessions={sessionsOf(selected)} />}

      {remoteOpen && <RemotePanel onClose={() => setRemoteOpen(false)} />}
    </main>
  );
}

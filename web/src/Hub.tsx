import { useEffect, useRef, useState } from "react";
import { authHeaders, checkAuthorized, UnauthorizedError } from "./auth";
import { UnauthorizedScreen } from "./UnauthorizedScreen";
import { harnessLabel, harnessOrder, type HarnessId, type HostInfo, type SessionInfo, type SessionsResponse } from "./session-types";

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

function openSession(key: string, folder?: string) {
  window.location.href = `/?session=${encodeURIComponent(key)}${folder ? `&folder=${encodeURIComponent(folder)}` : ""}`;
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

type DateRange = "any" | "today" | "week" | "month" | "older";
type SortOrder = "newest" | "oldest" | "title";
const dayMs = 24 * 60 * 60 * 1000;

function inRange(updatedAt: number, range: DateRange): boolean {
  const age = Date.now() - updatedAt;
  if (range === "today") return new Date(updatedAt).toDateString() === new Date().toDateString();
  if (range === "week") return age <= 7 * dayMs;
  if (range === "month") return age <= 30 * dayMs;
  if (range === "older") return age > 30 * dayMs;
  return true;
}

function sortSessions(sessions: SessionInfo[], order: SortOrder): SessionInfo[] {
  const sorted = [...sessions];
  if (order === "title") sorted.sort((a, b) => (a.title || "").localeCompare(b.title || "", undefined, { sensitivity: "base" }));
  else sorted.sort((a, b) => (order === "oldest" ? a.updatedAt - b.updatedAt : b.updatedAt - a.updatedAt));
  return sorted;
}

function SessionRow({ session }: { session: SessionInfo }) {
  const dot = stateDot(session);
  return (
    <li>
      <button type="button" className="hub-session" onClick={() => openSession(session.key)}>
        <span className={dot.className} aria-hidden="true" title={dot.label} />
        <span className="hub-session__body">
          <span className="hub-session__title">{session.title || "(untitled)"}</span>
          <span className="hub-session__meta">
            <span className="hub-session__badge">{harnessLabel[session.harness]}</span>
            <span className="hub-session__time">{relativeTime(session.updatedAt)}</span>
          </span>
          {session.open && <span className="hub-session__hint">open in a terminal · continues as a voice copy</span>}
        </span>
      </button>
    </li>
  );
}

function NewChat({ host, folders, agent, folder, onClose }: { host: HostInfo; folders: string[]; agent: HarnessId | "all"; folder: string; onClose: () => void }) {
  const available = [...host.harnesses].filter((harness) => harness.available).sort((a, b) => harnessOrder.indexOf(a.id) - harnessOrder.indexOf(b.id));
  const [chosenAgent, setChosenAgent] = useState<HarnessId | undefined>(
    available.find((harness) => harness.id === agent)?.id ?? available[0]?.id,
  );
  const [chosenFolder, setChosenFolder] = useState(folder === "all" ? "" : folder);
  if (available.length === 0) return <div className="hub-newchat"><p className="hub-muted">No coding agents are installed on {host.name}.</p></div>;
  return (
    <div className="hub-newchat" role="group" aria-label="New chat">
      <div className="hub-newchat__row">
        <span className="hub-newchat__label">Agent</span>
        <div className="hub-chips">
          {available.map((harness) => (
            <button key={harness.id} type="button" className={`hub-chip${chosenAgent === harness.id ? " hub-chip--on" : ""}`} aria-pressed={chosenAgent === harness.id}
              onClick={() => setChosenAgent(harness.id)}>{harness.label}</button>
          ))}
        </div>
      </div>
      <label className="hub-newchat__row">
        <span className="hub-newchat__label">Folder</span>
        <select className="hub-select hub-select--wide" value={chosenFolder} onChange={(event) => setChosenFolder(event.target.value)}>
          <option value="">Home folder</option>
          {folders.map((cwd) => <option key={cwd} value={cwd}>{shortenCwd(cwd)}</option>)}
        </select>
      </label>
      <div className="hub-newchat__actions">
        <button type="button" className="hub-more" onClick={onClose}>Cancel</button>
        <button type="button" className="hub-primary" disabled={!chosenAgent}
          onClick={() => chosenAgent && openSession(`${hostKeyPrefix(host)}new:${chosenAgent}`, chosenFolder || undefined)}>
          Start talking
        </button>
      </div>
    </div>
  );
}

function MachinePanel({ host, sessions }: { host: HostInfo; sessions: SessionInfo[] }) {
  const [query, setQuery] = useState("");
  const [agent, setAgent] = useState<HarnessId | "all">("all");
  const [folder, setFolder] = useState("all");
  const [range, setRange] = useState<DateRange>("any");
  const [order, setOrder] = useState<SortOrder>("newest");
  const [openOnly, setOpenOnly] = useState(false);
  const [newChatOpen, setNewChatOpen] = useState(false);
  const [limit, setLimit] = useState(pageSize);
  useEffect(() => {
    setQuery(""); setAgent("all"); setFolder("all"); setRange("any"); setOrder("newest"); setOpenOnly(false); setNewChatOpen(false); setLimit(pageSize);
  }, [host.id]);
  useEffect(() => setLimit(pageSize), [query, agent, folder, range, order, openOnly]);

  if (!host.online) {
    return <p className="hub-empty">{host.name} is offline. Its sessions appear here as soon as it reconnects.</p>;
  }

  // Folders are detected from the sessions themselves, most recently active first.
  const folderActivity = new Map<string, number>();
  for (const session of sessions) folderActivity.set(session.cwd, Math.max(folderActivity.get(session.cwd) ?? 0, session.updatedAt));
  const folders = [...folderActivity.entries()].sort((a, b) => b[1] - a[1]).map(([cwd]) => cwd);
  const newChatFolders = folders.filter((cwd) => cwd && shortenCwd(cwd) !== "~");

  const agents = harnessOrder.filter((id) => sessions.some((session) => session.harness === id));
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sortSessions(sessions.filter((session) => {
    if (agent !== "all" && session.harness !== agent) return false;
    if (folder !== "all" && session.cwd !== folder) return false;
    if (openOnly && !session.open) return false;
    if (!inRange(session.updatedAt, range)) return false;
    if (terms.length === 0) return true;
    const haystack = `${session.title} ${shortenCwd(session.cwd)} ${harnessLabel[session.harness]}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  }), order);
  const openCount = sessions.filter((session) => session.open).length;
  const filtered = agent !== "all" || folder !== "all" || range !== "any" || openOnly || terms.length > 0;

  // Group the visible page by folder, keeping the chosen order inside and across groups.
  const visible = matches.slice(0, limit);
  const groups: { cwd: string; sessions: SessionInfo[] }[] = [];
  for (const session of visible) {
    const group = folder === "all" ? groups.find((entry) => entry.cwd === session.cwd) : groups[0];
    if (group) group.sessions.push(session);
    else groups.push({ cwd: session.cwd, sessions: [session] });
  }

  return (
    <div className="hub-panel" role="tabpanel">
      <div className="hub-search">
        <input type="search" className="hub-search__input" placeholder={`Search ${sessions.length} sessions`} value={query}
          onChange={(event) => setQuery(event.target.value)} aria-label="Search sessions" autoComplete="off" />
        <button type="button" className="hub-primary" aria-expanded={newChatOpen} onClick={() => setNewChatOpen(!newChatOpen)}>
          {newChatOpen ? "Close" : "New chat"}
        </button>
      </div>

      {newChatOpen && <NewChat host={host} folders={newChatFolders} agent={agent} folder={folder} onClose={() => setNewChatOpen(false)} />}

      {sessions.length > 0 && (
        <div className="hub-filters">
          <div className="hub-chips" role="group" aria-label="Filter by agent">
            <button type="button" className={`hub-chip${agent === "all" ? " hub-chip--on" : ""}`} aria-pressed={agent === "all"} onClick={() => setAgent("all")}>
              All agents
            </button>
            {agents.map((id) => (
              <button key={id} type="button" className={`hub-chip${agent === id ? " hub-chip--on" : ""}`} aria-pressed={agent === id} onClick={() => setAgent(agent === id ? "all" : id)}>
                {harnessLabel[id]} <span className="hub-chip__count">{sessions.filter((session) => session.harness === id).length}</span>
              </button>
            ))}
            <button type="button" className={`hub-chip${openOnly ? " hub-chip--on" : ""}`} aria-pressed={openOnly} disabled={openCount === 0 && !openOnly} onClick={() => setOpenOnly(!openOnly)}>
              Open now <span className="hub-chip__count">{openCount}</span>
            </button>
          </div>
          <div className="hub-selects">
            <select className="hub-select" value={folder} onChange={(event) => setFolder(event.target.value)} aria-label="Folder">
              <option value="all">All folders ({folders.length})</option>
              {folders.map((cwd) => <option key={cwd} value={cwd}>{shortenCwd(cwd) || "(no folder)"}</option>)}
            </select>
            <select className="hub-select" value={range} onChange={(event) => setRange(event.target.value as DateRange)} aria-label="Date">
              <option value="any">Any time</option>
              <option value="today">Today</option>
              <option value="week">Past 7 days</option>
              <option value="month">Past 30 days</option>
              <option value="older">Older than 30 days</option>
            </select>
            <select className="hub-select" value={order} onChange={(event) => setOrder(event.target.value as SortOrder)} aria-label="Sort">
              <option value="newest">Newest first</option>
              <option value="oldest">Oldest first</option>
              <option value="title">Title A–Z</option>
            </select>
          </div>
        </div>
      )}

      {sessions.length === 0 && <p className="hub-empty">No sessions on {host.name} yet. Tap New chat to start one.</p>}
      {sessions.length > 0 && matches.length === 0 && (
        <p className="hub-empty">No sessions match. <button type="button" className="hub-link" onClick={() => {
          setQuery(""); setAgent("all"); setFolder("all"); setRange("any"); setOpenOnly(false);
        }}>Clear filters</button></p>
      )}
      {filtered && matches.length > 0 && <p className="hub-count">{matches.length} of {sessions.length} sessions</p>}

      {groups.map((group) => (
        <section key={group.cwd} className="hub-folder">
          <h3 className="hub-folder__title">
            <span>{shortenCwd(group.cwd) || "(no folder)"}</span>
            <span className="hub-folder__count">{matches.filter((session) => session.cwd === group.cwd).length}</span>
          </h3>
          <ul className="hub-sessions">
            {group.sessions.map((session) => <SessionRow key={session.key} session={session} />)}
          </ul>
        </section>
      ))}
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

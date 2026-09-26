import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";

// The agent's latest tool calls, shown as small cards that slide out beside the voice shape:
// at most three at a time, the oldest fading out as a new one arrives, and all of them fading
// away one after another once the agent starts answering.

export interface ToolActivityItem {
  id: number;
  name: string;
  summary: string;
  detail?: string;
  folder?: string;
  leaving: boolean;
  delay: number;
}

const MAX_VISIBLE = 3;
const LEAVE_MS = 420;
const STAGGER_MS = 140;

export function useToolActivity() {
  const [items, setItems] = useState<ToolActivityItem[]>([]);
  const nextId = useRef(0);
  const timers = useRef(new Set<number>());

  useEffect(() => () => {
    for (const timer of timers.current) window.clearTimeout(timer);
    timers.current.clear();
  }, []);

  const removeLater = useCallback((ids: number[], after: number) => {
    const timer = window.setTimeout(() => {
      timers.current.delete(timer);
      setItems((list) => list.filter((item) => !ids.includes(item.id)));
    }, after);
    timers.current.add(timer);
  }, []);

  const push = useCallback((event: { name: string; summary?: string; detail?: string; folder?: string }) => {
    const id = ++nextId.current;
    const item: ToolActivityItem = { id, name: event.name, summary: event.summary ?? `Using ${event.name}`, detail: event.detail, folder: event.folder, leaving: false, delay: 0 };
    setItems((list) => {
      const live = list.filter((entry) => !entry.leaving);
      const overflow = new Set(live.slice(0, Math.max(0, live.length + 1 - MAX_VISIBLE)).map((entry) => entry.id));
      if (overflow.size) removeLater([...overflow], LEAVE_MS);
      return [...list.map((entry) => overflow.has(entry.id) ? { ...entry, leaving: true, delay: 0 } : entry), item];
    });
  }, [removeLater]);

  const clear = useCallback(() => {
    setItems((list) => {
      const live = list.filter((entry) => !entry.leaving);
      if (!live.length) return list;
      removeLater(live.map((entry) => entry.id), LEAVE_MS + STAGGER_MS * live.length);
      // Oldest first, so the stack drains from the top down.
      return list.map((entry) => entry.leaving ? entry : { ...entry, leaving: true, delay: STAGGER_MS * live.indexOf(entry) });
    });
  }, [removeLater]);

  return { items, push, clear };
}

export function ToolActivityStack({ items }: { items: ToolActivityItem[] }) {
  if (!items.length) return null;
  return <ol className="tool-activity" aria-live="polite" aria-label="What the agent is doing">
    {items.map((item) => <li
      key={item.id}
      className={`tool-activity__item${item.leaving ? " tool-activity__item--leaving" : ""}`}
      style={{ "--delay": `${item.delay}ms` } as CSSProperties}
      aria-hidden={item.leaving || undefined}
    >
      <span className="tool-activity__summary">
        <span className="tool-activity__tool">{item.name.replace(/^mcp__.*__/, "")}</span>
        {item.summary}
      </span>
      {item.detail && <code className="tool-activity__detail" title={item.detail}>{item.detail}</code>}
      {item.folder && <span className="tool-activity__folder">in {item.folder}</span>}
    </li>)}
  </ol>;
}

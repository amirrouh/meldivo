import { createClaudeAdapter } from "./claude.js";
import { createOpenCodeAdapter, openCodeLivePort } from "./opencode.js";
import { createPiAdapter } from "./pi.js";
import type { HarnessAdapter, HarnessId, SessionInfo } from "./types.js";

export type { HarnessAdapter, HarnessId, SendTarget, SessionInfo, TurnEvent } from "./types.js";
export { createClaudeAdapter, createOpenCodeAdapter, createPiAdapter, openCodeLivePort };

export interface CreateAdaptersOptions {
  /** Fake home directory to resolve all filesystem roots from (tests point this at fixtures). */
  home?: string;
  /** Overrides for each harness's CLI binary path (tests point these at fake CLIs). */
  bins?: Partial<Record<HarnessId, string>>;
}

/** Builds the three harness adapters in fallback order [pi, opencode, claude]. */
export function createAdapters(options: CreateAdaptersOptions = {}): HarnessAdapter[] {
  const { home, bins } = options;
  return [
    createPiAdapter({ home, bin: bins?.pi }),
    createOpenCodeAdapter({ home, bin: bins?.opencode }),
    createClaudeAdapter({ home, bin: bins?.claude }),
  ];
}

/** Lists sessions across all adapters, merged and sorted most-recently-updated first. */
export async function listAllSessions(adapters: HarnessAdapter[], limit?: number): Promise<SessionInfo[]> {
  const perAdapter = await Promise.all(
    adapters.map(async (adapter) => {
      try {
        return await adapter.listSessions(limit);
      } catch {
        return [];
      }
    }),
  );
  const merged = perAdapter.flat().sort((a, b) => b.updatedAt - a.updatedAt);
  return limit ? merged.slice(0, limit) : merged;
}

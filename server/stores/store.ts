// The store seam.
//
// A SessionStore hides one on-disk layout behind a fixed surface. The server
// routes and the scan worker talk only to this interface, so adding a data
// source is a new file in this directory rather than a third copy of the
// layout walk (which is how server/index.ts, server/scan-worker.ts and
// scripts/verify-scan.mjs came to disagree about the Kiro layout).
//
// Division of responsibility:
//   adapter   — directory layout, id codec, which records exist, how an
//               execution's end time is derived/clamped, what counts as a
//               session.
//   collector — dedup, interval merging, peak parallelism, faceting, totals
//               (server/aggregate.ts). Store-agnostic by construction.

import type { ScanSink } from "../aggregate";

export type StoreId = "kiro" | "kirocrew";

/** One entry of GET /api/workspaces. */
export interface WorkspaceListEntry {
  /** Opaque, URL-safe workspace handle. Round-trips through the session route. */
  id: string;
  /** Human-readable workspace path (may be "" if the store has none). */
  path: string;
  /** Display name. */
  name: string;
  sessionCount: number;
  sessions: { id: string; title: string; date: number }[];
}

/** One tool call / agent action attached to a message. */
export interface SessionAction {
  actionType: string;
  actionState: string;
  input: unknown;
  output: unknown;
}

export interface SessionHistoryEntry {
  role: string;
  content: string;
  executionId: string | null;
  actions: SessionAction[];
  cost: number;
}

/** GET /api/workspaces/:workspaceId/sessions/:sessionId */
export interface SessionDetail {
  sessionId: string;
  title: string;
  model: string;
  autonomyMode: string;
  sessionType: string;
  contextUsage?: number;
  workspacePath: string;
  messageCount: number;
  totalCost: number;
  history: SessionHistoryEntry[];
}

export interface SessionStore {
  readonly id: StoreId;
  /** Short human label for /api/health. */
  readonly label: string;
  /** Root directory the store reads from. */
  readonly root: string;
  /** Directory holding the session index, for /api/health. */
  readonly sessionsDir: string;
  /** True when the store's data actually exists on this machine. */
  isAvailable(): boolean;
  listWorkspaces(): Promise<WorkspaceListEntry[]>;
  /** null when the session does not exist or the params escape the store. */
  readSessionDetail(workspaceId: string, sessionId: string): Promise<SessionDetail | null>;
  /**
   * Walk the store, emitting rows into the sink. extraSources are additional
   * roots in the store's own layout (exported archives); adapters without a
   * meaningful notion of them ignore the argument.
   */
  scan(sink: ScanSink, extraSources?: string[]): Promise<void>;
}

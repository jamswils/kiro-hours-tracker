// Single source of truth for the row/result shapes that cross the
// scan-worker -> server -> client boundary.
//
// These were previously triplicated in server/index.ts, server/scan-worker.ts
// and src/components/Dashboard.tsx, and had drifted: the worker emitted
// endRaw/status and returned totalTimeMsRaw/totalExecTimeMsRaw/
// peakParallelActive/peakParallelRaw/workspacesRaw, none of which existed in
// index.ts's local copies. The definitions below are the UNION of what the
// worker actually emits, so the JSON payload the client receives is unchanged
// — only the types now describe it truthfully.

/** One execution (a single agent turn / run) with UTC millisecond bounds. */
export interface ExecutionRow {
  start: number;
  /**
   * Active end. For aborted executions in the Kiro store this is clamped to
   * the last action's emittedAt + 60s; otherwise it equals endRaw. Drives
   * calendar bars and the "active" totals.
   */
  end: number;
  /**
   * Raw end as recorded by the store, never clamped. Optional because not
   * every store distinguishes the two (the KiroCrew store does not — its
   * usage rows carry a real duration, so endRaw === end there).
   */
  endRaw?: number;
  /** Store-specific status: Kiro "succeed"|"aborted"|"user-aborted"|"", KiroCrew phase. */
  status?: string;
  sessionId: string;
  sessionTitle: string;
  sessionType: string;
  autonomyMode: string;
  model: string;
  workspace: string;
  executionId: string;
  credits: number;
}

/** One session, as listed by the store's session index. */
export interface SessionRow {
  dateCreated: number;
  sessionId: string;
  sessionTitle: string;
  sessionType: string;
  autonomyMode: string;
  model: string;
  workspace: string;
}

/** Counts by categorical dimension, for the dashboard's filter chips. */
export interface Facets {
  sessionType: Record<string, number>;
  autonomyMode: Record<string, number>;
  model: Record<string, number>;
}

/** An execution over the audit threshold. Still counted in all totals. */
export interface LongExecution {
  start: number;
  end: number;
  durationMs: number;
  workspace: string;
  executionId: string;
  sessionId: string;
  source: string;
}

/** Per-workspace rollup. */
export interface WorkspaceSummary {
  name: string;
  sessions: number;
  executions: number;
  timeMs: number;
  credits: number;
}

/** Everything the scan worker prints to stdout. */
export interface ScanResult {
  /** Merged wall clock over active ends. */
  totalTimeMs: number;
  /** Sum of per-execution active durations (double-counts parallel work). */
  totalExecTimeMs: number;
  /** Merged wall clock over raw ends. */
  totalTimeMsRaw: number;
  /** Sum of per-execution raw durations. */
  totalExecTimeMsRaw: number;
  peakParallelActive: number;
  peakParallelRaw: number;
  totalSessions: number;
  totalExecutions: number;
  totalCredits: number;
  executions: ExecutionRow[];
  sessions: SessionRow[];
  workspaces: WorkspaceSummary[];
  workspacesRaw: WorkspaceSummary[];
  facets: Facets;
  longExecutions?: LongExecution[];
}

/** What /api/dashboard serves: a ScanResult plus cache bookkeeping. */
export interface DashboardResult extends ScanResult {
  lastUpdated: number;
  scanning: boolean;
}

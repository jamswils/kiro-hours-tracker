// Store-agnostic aggregation maths for the scanner.
//
// Every function here is pure (or, for the collector, a small explicit state
// machine) so the numbers the dashboard shows can be unit-tested without a
// filesystem. Store adapters emit rows into a ScanSink; this module owns
// dedup, interval merging, peak-parallelism, faceting and the final rollup.
// Adapters own their own layout, id codec and end-clamping rules.

import type {
  ExecutionRow,
  Facets,
  LongExecution,
  ScanResult,
  SessionRow,
  WorkspaceSummary,
} from "./types";

/** Executions longer than this are listed in longExecutions[] for audit. They
 *  are still counted in every total — purely a display threshold. */
export const LONG_EXECUTION_MS = 4 * 60 * 60 * 1000; // 4h

const DAY_MS = 86_400_000;

// ---------------------------------------------------------------------------
// Interval maths
// ---------------------------------------------------------------------------

/**
 * Total wall-clock ms covered by the union of the intervals. Overlapping
 * executions (parallel subagents, two chats at once) are counted once.
 */
export function mergeIntervalsMs(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let currentStart = sorted[0][0];
  let currentEnd = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= currentEnd) {
      if (e > currentEnd) currentEnd = e;
    } else {
      total += currentEnd - currentStart;
      currentStart = s;
      currentEnd = e;
    }
  }
  total += currentEnd - currentStart;
  return total;
}

/**
 * Maximum number of intervals overlapping at any instant (sweep-line).
 * Ends are processed before starts at the same timestamp, so a run that ends
 * exactly when the next begins is not counted as parallel.
 */
export function peakParallel(intervals: [number, number][]): number {
  if (!intervals.length) return 0;
  const events: [number, number][] = [];
  for (const [a, b] of intervals) {
    events.push([a, 1]);
    events.push([b, -1]);
  }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let peak = 0;
  let cur = 0;
  for (const [, d] of events) {
    cur += d;
    if (cur > peak) peak = cur;
  }
  return peak;
}

export interface DaySegment {
  /** YYYY-MM-DD in the requested offset's local calendar. */
  day: string;
  start: number;
  end: number;
}

function dayKeyFromShifted(shiftedDayStart: number): string {
  const d = new Date(shiftedDayStart);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, "0");
  const day = String(d.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/**
 * Split [start, end) at local-midnight boundaries for the given UTC offset in
 * minutes (positive = east of UTC, matching a display timezone rather than
 * Date#getTimezoneOffset's inverted sign).
 *
 * The returned segments are contiguous and their durations sum to exactly
 * end - start, so per-day bucketing can never invent or lose time.
 */
export function splitIntervalByDay(
  start: number,
  end: number,
  tzOffsetMinutes = 0,
): DaySegment[] {
  const out: DaySegment[] = [];
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return out;
  const offsetMs = tzOffsetMinutes * 60_000;
  let cursor = start;
  // Bounded: each iteration advances cursor by at least 1ms and normally by a
  // whole day, so the loop terminates for any finite span.
  while (cursor < end) {
    const shifted = cursor + offsetMs;
    const shiftedDayStart = Math.floor(shifted / DAY_MS) * DAY_MS;
    const dayEnd = shiftedDayStart + DAY_MS - offsetMs;
    const segEnd = Math.min(end, dayEnd);
    out.push({ day: dayKeyFromShifted(shiftedDayStart), start: cursor, end: segEnd });
    cursor = segEnd;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

/**
 * What a store adapter writes into during a scan. Deliberately narrow: the
 * adapter decides what a session and an execution ARE for its layout, the
 * collector decides what the totals mean.
 */
export interface ScanSink {
  /**
   * Register that a workspace has n sessions. Drives totalSessions and the
   * per-workspace session count. Called once per workspace (not per session)
   * so a store whose index lists sessions it cannot open still counts them.
   */
  countSessions(workspace: string, n: number): void;
  /** Emit one session row. Also bumps the sessionType/autonomyMode/model facets. */
  session(row: SessionRow): void;
  /**
   * Emit one execution row. Dedup and field-merge across passes is handled
   * here, keyed on `workspace|executionId` — the adapter is responsible for
   * making executionId stable across its own passes.
   */
  execution(row: ExecutionRow): void;
  /**
   * Credits observed for a workspace. Kept separate from execution rows
   * because both stores record spend for work that has no usable interval
   * (Kiro: execution files with no start/end; KiroCrew: whole-run rollups).
   */
  credits(workspace: string, amount: number): void;
}

export interface ScanCollector {
  sink: ScanSink;
  finalize(): ScanResult;
}

function bumpFacet(map: Record<string, number>, key: string) {
  const k = key || "unknown";
  map[k] = (map[k] || 0) + 1;
}

export function createScanCollector(): ScanCollector {
  const executions: ExecutionRow[] = [];
  const sessions: SessionRow[] = [];
  const execIndex = new Map<string, number>();
  const workspaceStats: Record<string, WorkspaceSummary> = {};
  const facets: Facets = { sessionType: {}, autonomyMode: {}, model: {} };
  let totalSessions = 0;
  let totalCredits = 0;

  const ensureWorkspace = (name: string): WorkspaceSummary => {
    let entry = workspaceStats[name];
    if (!entry) {
      entry = { name, sessions: 0, executions: 0, timeMs: 0, credits: 0 };
      workspaceStats[name] = entry;
    }
    return entry;
  };

  const sink: ScanSink = {
    countSessions(workspace, n) {
      if (!(n > 0)) return;
      totalSessions += n;
      ensureWorkspace(workspace).sessions += n;
    },

    session(row) {
      sessions.push(row);
      bumpFacet(facets.sessionType, row.sessionType);
      bumpFacet(facets.autonomyMode, row.autonomyMode);
      bumpFacet(facets.model, row.model);
    },

    execution(row) {
      const key = `${row.workspace}|${row.executionId}`;
      const existingIdx = execIndex.get(key);
      if (existingIdx === undefined) {
        execIndex.set(key, executions.length);
        executions.push({ ...row });
        return;
      }
      // A second pass over the same execution: fill blanks, and let a
      // tighter action-backed end win over a looser one.
      const existing = executions[existingIdx];
      if (existing.model === "unknown" && row.model !== "unknown") existing.model = row.model;
      if (existing.sessionType === "unknown" && row.sessionType !== "unknown") {
        existing.sessionType = row.sessionType;
      }
      if (existing.autonomyMode === "unknown" && row.autonomyMode !== "unknown") {
        existing.autonomyMode = row.autonomyMode;
      }
      if (!existing.sessionTitle && row.sessionTitle) existing.sessionTitle = row.sessionTitle;
      if (!existing.sessionId && row.sessionId) existing.sessionId = row.sessionId;
      if (row.credits > 0 && existing.credits === 0) existing.credits = row.credits;
      if (row.end > 0 && (row.end < existing.end || existing.end === 0)) existing.end = row.end;
      const rowRaw = row.endRaw ?? 0;
      const existingRaw = existing.endRaw ?? 0;
      if (rowRaw > 0 && rowRaw > existingRaw) existing.endRaw = rowRaw;
      if (row.status && !existing.status) existing.status = row.status;
    },

    credits(workspace, amount) {
      if (!(amount > 0)) return;
      totalCredits += amount;
      ensureWorkspace(workspace).credits += amount;
    },
  };

  function finalize(): ScanResult {
    // Recompute every timing stat from the FINAL deduped rows. Per-pass
    // accumulators would double-count when a later pass shortens an aborted
    // execution's active end.
    let execTimeMs = 0;
    let execTimeMsRaw = 0;
    const perWorkspaceMs = new Map<string, number>();
    const perWorkspaceMsRaw = new Map<string, number>();
    const perWorkspaceCount = new Map<string, number>();
    const longExecs: LongExecution[] = [];

    for (const e of executions) {
      const dur = Math.max(0, e.end - e.start);
      const durRaw = Math.max(0, (e.endRaw || e.end) - e.start);
      execTimeMs += dur;
      execTimeMsRaw += durRaw;
      perWorkspaceMs.set(e.workspace, (perWorkspaceMs.get(e.workspace) || 0) + dur);
      perWorkspaceMsRaw.set(e.workspace, (perWorkspaceMsRaw.get(e.workspace) || 0) + durRaw);
      perWorkspaceCount.set(e.workspace, (perWorkspaceCount.get(e.workspace) || 0) + 1);
      if (durRaw > LONG_EXECUTION_MS) {
        longExecs.push({
          start: e.start,
          end: e.endRaw || e.end,
          durationMs: durRaw,
          workspace: e.workspace,
          executionId: e.executionId,
          sessionId: (e.sessionId || "").slice(0, 8),
          source: "final",
        });
      }
    }

    for (const [name, ms] of perWorkspaceMs) {
      const entry = ensureWorkspace(name);
      entry.executions = perWorkspaceCount.get(name) || 0;
      entry.timeMs = ms;
    }

    const activeIntervals: [number, number][] = executions.map((e) => [e.start, e.end]);
    const rawIntervals: [number, number][] = executions.map((e) => [e.start, e.endRaw || e.end]);

    const workspaces = Object.values(workspaceStats).sort((a, b) => b.timeMs - a.timeMs);
    const workspacesRaw: WorkspaceSummary[] = Array.from(perWorkspaceMsRaw.entries())
      .map(([name, timeMs]) => ({
        name,
        sessions: workspaceStats[name]?.sessions || 0,
        executions: perWorkspaceCount.get(name) || 0,
        timeMs,
        credits: workspaceStats[name]?.credits || 0,
      }))
      .sort((a, b) => b.timeMs - a.timeMs);

    return {
      totalTimeMs: mergeIntervalsMs(activeIntervals),
      totalExecTimeMs: execTimeMs,
      totalTimeMsRaw: mergeIntervalsMs(rawIntervals),
      totalExecTimeMsRaw: execTimeMsRaw,
      peakParallelActive: peakParallel(activeIntervals),
      peakParallelRaw: peakParallel(rawIntervals),
      totalSessions,
      totalExecutions: executions.length,
      totalCredits,
      executions: executions.slice().sort((a, b) => a.start - b.start),
      sessions: sessions.slice().sort((a, b) => a.dateCreated - b.dateCreated),
      workspaces,
      workspacesRaw,
      facets,
      longExecutions: longExecs.sort((a, b) => b.durationMs - a.durationMs),
    };
  }

  return { sink, finalize };
}

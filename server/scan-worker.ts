// Subprocess that scans Kiro session data from multiple sources.
// Outputs JSON to stdout.
//
// Design: this file emits RAW execution and session records (UTC timestamps
// plus metadata). All timezone-dependent bucketing (per-day, per-week,
// inside/outside schedule) happens client-side in Dashboard.tsx so the same
// payload can drive any user's configured timezone without a rescan.
//
// What's here:
//   - Aggregate totals that don't depend on timezone (session count, credit
//     total, wall-clock merged across the whole dataset).
//   - executions[]: one row per execution, UTC ms start/end, with meta.
//   - sessions[]:   one row per session, UTC ms dateCreated, with meta.
//   - facets:       counts by sessionType / autonomyMode / model.
//   - workspaces[]: per-workspace totals.
//   - longExecutions[]: records over 4h for audit (not filtered from totals).
//
// Evidence for session-file shape:
//   tools/kiro-sessions-inspector/KIRO_SESSION_FORMAT.md (execution files have
//   executionId, startTime, endTime, chatSessionId, usageSummary; session files
//   have sessionType, autonomyMode, selectedModel, defaultModelTitle, title).

import fs from "fs";
import path from "path";
import crypto from "crypto";

const globalStorage = process.argv[2];
const sessionsDir = process.argv[3];
const extraSources = process.argv.slice(4);

// Executions longer than this get listed in longExecutions[] for audit.
// They are still counted in all totals. Purely a display threshold.
const LONG_EXECUTION_MS = 4 * 60 * 60 * 1000; // 4h

function decodeBase64Url(str: string): string {
  const tryDecode = (s: string): string | null => {
    try {
      let b = s.replace(/-/g, "+").replace(/_/g, "/");
      b += "=".repeat((4 - (b.length % 4)) % 4);
      const decoded = Buffer.from(b, "base64").toString("utf-8");
      let clean = "";
      for (const ch of decoded) {
        const code = ch.charCodeAt(0);
        if (code >= 0x20 && code <= 0x7e && ch !== "?") clean += ch;
        else if (code > 0x7e) break;
        else if (code < 0x20) break;
      }
      return clean;
    } catch { return null; }
  };
  return tryDecode(str) ?? tryDecode(str.slice(0, -1)) ?? str;
}

function projectNameFromPath(decodedPath: string): string {
  return decodedPath.split(/[\\/]/).filter(Boolean).pop() || decodedPath;
}

// Merge overlapping intervals: returns total wall-clock ms.
function mergeIntervalsMs(intervals: [number, number][]): number {
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface ExecutionRow {
  start: number;
  end: number;       // active end: for status=aborted sessions, clamped to
                     //             last action.emittedAt + 60s. Otherwise
                     //             equal to endRaw. Drives calendar bars.
  endRaw: number;    // raw endTime from Kiro. Retained so the UI can show
                     //             both "active" and "raw" totals side by
                     //             side and you can see the difference.
  status: string;    // "succeed" | "aborted" | "user-aborted" | ""
  sessionId: string;
  sessionTitle: string;
  sessionType: string;
  autonomyMode: string;
  model: string;
  workspace: string;
  executionId: string;
  credits: number;
}

interface SessionRow {
  dateCreated: number;
  sessionId: string;
  sessionTitle: string;
  sessionType: string;
  autonomyMode: string;
  model: string;
  workspace: string;
}

interface LongExecution {
  start: number;
  end: number;
  durationMs: number;
  workspace: string;
  executionId: string;
  sessionId: string;
  source: string;
}

interface WorkspaceEntry {
  name: string;
  sessions: number;
  executions: number;
  timeMs: number;
  credits: number;
}

interface SessionMeta {
  sessionType: string;
  autonomyMode: string;
  model: string;
  title: string;
}

function readSessionMeta(sessionFile: string): SessionMeta {
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    return {
      sessionType: String(data.sessionType || "unknown"),
      autonomyMode: String(data.autonomyMode || "unknown"),
      model: String(data.selectedModel || data.defaultModelTitle || "unknown"),
      title: String(data.title || ""),
    };
  } catch {
    return { sessionType: "unknown", autonomyMode: "unknown", model: "unknown", title: "" };
  }
}

function bumpFacet(map: Record<string, number>, key: string) {
  const k = key || "unknown";
  map[k] = (map[k] || 0) + 1;
}

// Minimum tail after the last action for aborted execs. Covers the case where
// the user saw the reply, then hit stop a few seconds later, and stops us
// clamping to zero when an action lists no emittedAt.
const ABORTED_TAIL_GRACE_MS = 60_000;

// For status=aborted execs, Kiro's `endTime` field lags real activity, often
// by hours, because it is written when the session is torn down. Prefer the
// last action's emittedAt plus a small grace tail so wall-clock totals and
// calendar bars reflect when the agent actually stopped doing work.
function effectiveEnd(data: any): number {
  const rawEnd = Number(data.endTime || 0);
  const rawStart = Number(data.startTime || 0);
  if (!rawEnd || !rawStart) return rawEnd;
  const status = String(data.status || "").toLowerCase();
  if (status !== "aborted" && status !== "user-aborted") return rawEnd;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  let lastAt = 0;
  for (const a of actions) {
    const t = Number(a?.emittedAt || 0);
    if (t > lastAt) lastAt = t;
  }
  if (!lastAt) return Math.min(rawEnd, rawStart + ABORTED_TAIL_GRACE_MS);
  const clamped = Math.min(rawEnd, lastAt + ABORTED_TAIL_GRACE_MS);
  return Math.max(rawStart, clamped);
}

// ---------------------------------------------------------------------------
// Scan
// ---------------------------------------------------------------------------
interface ScanState {
  executions: ExecutionRow[];
  sessions: SessionRow[];
  workspaceStats: Record<string, WorkspaceEntry>;
  totals: { sessions: number; executions: number; credits: number; execTimeMs: number };
  facets: { sessionType: Record<string, number>; autonomyMode: Record<string, number>; model: Record<string, number> };
  longExecutions: LongExecution[];
  // Dedup key for execution rows.
  execIndex: Map<string, number>;
}

function scanSource(
  sourceBase: string,
  sourceSessionsDir: string,
  state: ScanState,
  sourceLabel: string,
  readFullExecFiles: boolean,
) {
  if (!fs.existsSync(sourceSessionsDir)) return;
  const dirs = fs.readdirSync(sourceSessionsDir, { withFileTypes: true }).filter(d => d.isDirectory());

  for (const d of dirs) {
    const wsFolder = path.join(sourceSessionsDir, d.name);
    const sessionsFile = path.join(wsFolder, "sessions.json");
    let sessions: any[] = [];
    try { sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8")); } catch { continue; }
    if (!Array.isArray(sessions) || sessions.length === 0) continue;

    const decodedPath = decodeBase64Url(d.name);
    const projectName = projectNameFromPath(decodedPath);
    const wsHash = crypto.createHash("sha256").update(decodedPath).digest("hex").slice(0, 32);
    const wsExecDir = path.join(sourceBase, wsHash);

    state.totals.sessions += sessions.length;

    // Per-session metadata map + session row emission.
    const sessionMeta = new Map<string, SessionMeta>();
    for (const s of sessions) {
      const id = String(s.sessionId || "");
      if (!id) continue;
      const meta = readSessionMeta(path.join(wsFolder, `${id}.json`));
      if (!meta.title) meta.title = String(s.title || "");
      sessionMeta.set(id, meta);
      bumpFacet(state.facets.sessionType, meta.sessionType);
      bumpFacet(state.facets.autonomyMode, meta.autonomyMode);
      bumpFacet(state.facets.model, meta.model);
      state.sessions.push({
        dateCreated: Number(s.dateCreated),
        sessionId: id,
        sessionTitle: meta.title,
        sessionType: meta.sessionType,
        autonomyMode: meta.autonomyMode,
        model: meta.model,
        workspace: projectName,
      });
    }

    if (!fs.existsSync(wsExecDir)) continue;
    let wsCredits = 0;

    // Dedup by workspace+executionId so that the cheap index-pass row and the
    // richer full-file pass row merge even when sessionId or end time differ.
    // Old key `start|end|sessionId` split them because the index pass emits
    // sessionId="" and the full-file pass emits the real id, and because the
    // full-file pass may shorten `end` for aborted execs.
    const pushExec = (row: ExecutionRow) => {
      const key = `${row.workspace}|${row.executionId}`;
      const existingIdx = state.execIndex.get(key);
      if (existingIdx === undefined) {
        state.execIndex.set(key, state.executions.length);
        state.executions.push(row);
      } else {
        const existing = state.executions[existingIdx];
        if (existing.model === "unknown" && row.model !== "unknown") existing.model = row.model;
        if (existing.sessionType === "unknown" && row.sessionType !== "unknown") existing.sessionType = row.sessionType;
        if (existing.autonomyMode === "unknown" && row.autonomyMode !== "unknown") existing.autonomyMode = row.autonomyMode;
        if (!existing.sessionTitle && row.sessionTitle) existing.sessionTitle = row.sessionTitle;
        if (!existing.sessionId && row.sessionId) existing.sessionId = row.sessionId;
        if (row.credits > 0 && existing.credits === 0) existing.credits = row.credits;
        // The full-file pass has access to action-level emittedAt and can
        // shrink active `end` for aborted executions. Honour that: a later
        // pass with a tighter, action-backed end wins.
        if (row.end > 0 && (row.end < existing.end || existing.end === 0)) {
          existing.end = row.end;
        }
        // endRaw is Kiro's original endTime, never clamped. Keep the larger
        // value so we can show "raw total" alongside "active total".
        if (row.endRaw > 0 && row.endRaw > existing.endRaw) existing.endRaw = row.endRaw;
        // Status comes from the full-file pass; don't overwrite with "".
        if (row.status && !existing.status) existing.status = row.status;
      }
    };

    // Index file pass: fast timing, minimal metadata. Totals are computed
    // from the final deduped rows in scan(); don't accumulate here.
    let foundIndex = false;
    try {
      const entries = fs.readdirSync(wsExecDir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) continue;
        const filePath = path.join(wsExecDir, entry.name);
        try {
          const indexData = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (!indexData.executions || !Array.isArray(indexData.executions)) continue;
          foundIndex = true;
          for (const exec of indexData.executions) {
            if (!exec.startTime || !exec.endTime) continue;
            pushExec({
              start: exec.startTime, end: exec.endTime, endRaw: exec.endTime,
              status: String(exec.status || ""),
              sessionId: "",
              sessionTitle: "",
              sessionType: "unknown",
              autonomyMode: "unknown",
              model: "unknown",
              workspace: projectName,
              executionId: String(exec.executionId || "").slice(0, 8),
              credits: 0,
            });
          }
        } catch {}
      }
    } catch {}

    // Full exec-file pass: supplies chatSessionId + credits + status +
    // aborted-clamp via effectiveEnd. Previously gated on readFullExecFiles
    // OR !foundIndex so the live source skipped this pass when index files
    // were readable. That left aborted execs unclamped on live (phantom
    // tails back on the calendar and in totals). Now unconditional: the
    // correctness win outweighs the extra IO.
    {
      try {
        const entries = fs.readdirSync(wsExecDir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const subDir = path.join(wsExecDir, entry.name);
          let files: string[];
          try { files = fs.readdirSync(subDir); } catch { continue; }
          for (const file of files) {
            const filePath = path.join(subDir, file);
            try {
              const stat = fs.statSync(filePath);
              if (!stat.isFile() || stat.size < 100) continue;
              const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
              if (!data.executionId) continue;

              const sid = String(data.chatSessionId || "");
              const meta = sessionMeta.get(sid);
              const cost = Array.isArray(data.usageSummary)
                ? data.usageSummary.reduce((sum: number, s: any) => sum + (s.usage || 0), 0)
                : 0;

              if (data.startTime && data.endTime) {
                const endEffective = effectiveEnd(data);
                pushExec({
                  start: data.startTime,
                  end: endEffective,
                  endRaw: Number(data.endTime),
                  status: String(data.status || ""),
                  sessionId: sid,
                  sessionTitle: meta?.title || "",
                  sessionType: meta?.sessionType || "unknown",
                  autonomyMode: data.autonomyMode ? String(data.autonomyMode) : (meta?.autonomyMode || "unknown"),
                  model: meta?.model || "unknown",
                  workspace: projectName,
                  executionId: String(data.executionId || "").slice(0, 8),
                  credits: cost,
                });
              }

              if (cost > 0) {
                wsCredits += cost;
                state.totals.credits += cost;
              }
            } catch {}
          }
        }
      } catch {}
    }

    const existing = state.workspaceStats[projectName];
    if (existing) {
      existing.sessions += sessions.length;
      existing.credits += wsCredits;
    } else if (sessions.length > 0) {
      state.workspaceStats[projectName] = { name: projectName, sessions: sessions.length, executions: 0, timeMs: 0, credits: wsCredits };
    }
  }
}

function scan() {
  const state: ScanState = {
    executions: [],
    sessions: [],
    workspaceStats: {},
    totals: { sessions: 0, executions: 0, credits: 0, execTimeMs: 0 },
    facets: { sessionType: {}, autonomyMode: {}, model: {} },
    longExecutions: [],
    execIndex: new Map(),
  };

  scanSource(globalStorage, sessionsDir, state, "live", false);
  for (const extra of extraSources) {
    const extraWs = path.join(extra, "workspace-sessions");
    scanSource(extra, extraWs, state, "extra", true);
  }

  // Recompute all timing stats from the final deduped executions list. The
  // per-pass accumulators were dropped so that when the full-file pass
  // shortens an aborted exec's end, the totals honour the shorter value
  // instead of double-counting the original.
  //
  // Two parallel sets of totals are emitted so the UI can show both without
  // hiding data:
  //   active: uses `end` (aborted sessions clipped to last action + 60s).
  //   raw:    uses `endRaw` (Kiro's original endTime, no fallback).
  let execTimeMs = 0;
  let execTimeMsRaw = 0;
  const perWorkspaceMs = new Map<string, number>();
  const perWorkspaceMsRaw = new Map<string, number>();
  const perWorkspaceCount = new Map<string, number>();
  const longExecs: LongExecution[] = [];
  for (const e of state.executions) {
    const dur = Math.max(0, e.end - e.start);
    const durRaw = Math.max(0, (e.endRaw || e.end) - e.start);
    execTimeMs += dur;
    execTimeMsRaw += durRaw;
    perWorkspaceMs.set(e.workspace, (perWorkspaceMs.get(e.workspace) || 0) + dur);
    perWorkspaceMsRaw.set(e.workspace, (perWorkspaceMsRaw.get(e.workspace) || 0) + durRaw);
    perWorkspaceCount.set(e.workspace, (perWorkspaceCount.get(e.workspace) || 0) + 1);
    if (durRaw > LONG_EXECUTION_MS) {
      longExecs.push({
        start: e.start, end: e.endRaw || e.end, durationMs: durRaw,
        workspace: e.workspace, executionId: e.executionId,
        sessionId: (e.sessionId || "").slice(0, 8),
        source: "final",
      });
    }
  }
  // Seed workspaceStats with per-workspace time and execution counts now that
  // dedup is complete. Session counts were already pushed during the scan.
  for (const [name, ms] of perWorkspaceMs) {
    const entry = state.workspaceStats[name] || { name, sessions: 0, executions: 0, timeMs: 0, credits: 0 };
    entry.executions = perWorkspaceCount.get(name) || 0;
    entry.timeMs = ms;
    state.workspaceStats[name] = entry;
  }
  state.totals.executions = state.executions.length;
  state.totals.execTimeMs = execTimeMs;

  // Global wall-clock time: merged across ALL executions (timezone-independent).
  const allIntervals: [number, number][] = state.executions.map(e => [e.start, e.end]);
  const totalTimeMs = mergeIntervalsMs(allIntervals);
  const allIntervalsRaw: [number, number][] = state.executions.map(e => [e.start, e.endRaw || e.end]);
  const totalTimeMsRaw = mergeIntervalsMs(allIntervalsRaw);

  // Peak parallel executions at any instant: sweep-line so we never
  // double-count merged sessions. Both active and raw.
  function peakParallel(intervals: [number, number][]): number {
    if (!intervals.length) return 0;
    const events: [number, number][] = [];
    for (const [a, b] of intervals) { events.push([a, 1]); events.push([b, -1]); }
    events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let peak = 0, cur = 0;
    for (const [, d] of events) { cur += d; if (cur > peak) peak = cur; }
    return peak;
  }
  const peakParallelActive = peakParallel(allIntervals);
  const peakParallelRaw = peakParallel(allIntervalsRaw);

  const workspaces = Object.values(state.workspaceStats).sort((a, b) => b.timeMs - a.timeMs);
  const workspacesRaw = Array.from(perWorkspaceMsRaw.entries()).map(([name, timeMs]) => ({
    name,
    sessions: state.workspaceStats[name]?.sessions || 0,
    executions: perWorkspaceCount.get(name) || 0,
    timeMs,
    credits: state.workspaceStats[name]?.credits || 0,
  })).sort((a, b) => b.timeMs - a.timeMs);

  return {
    // Active-end totals (aborted sessions clipped). Calendar bars use these.
    totalTimeMs,
    totalExecTimeMs: state.totals.execTimeMs,
    // Raw-end totals (Kiro's original endTime, no fallback).
    totalTimeMsRaw,
    totalExecTimeMsRaw: execTimeMsRaw,
    // Parallelism.
    peakParallelActive,
    peakParallelRaw,
    // Sessions + executions + credits.
    totalSessions: state.totals.sessions,
    totalExecutions: state.totals.executions,
    totalCredits: state.totals.credits,
    // Rows.
    executions: state.executions.sort((a, b) => a.start - b.start),
    sessions: state.sessions.sort((a, b) => a.dateCreated - b.dateCreated),
    workspaces,
    workspacesRaw,
    facets: state.facets,
    longExecutions: longExecs.sort((a, b) => b.durationMs - a.durationMs),
  };
}

const result = scan();
console.log(JSON.stringify(result));

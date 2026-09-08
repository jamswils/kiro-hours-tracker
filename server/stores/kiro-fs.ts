// Kiro IDE filesystem store.
//
// Layout (see KIRO_SESSION_FORMAT.md):
//   <globalStorage>/workspace-sessions/<base64url(workspacePath)>/
//        sessions.json                 index: [{sessionId, title, dateCreated}]
//        <sessionId>.json              session: sessionType, autonomyMode,
//                                      selectedModel, history[]
//   <globalStorage>/<sha256(workspacePath).slice(0,32)>/
//        <indexFile>.json              { executions: [{executionId, startTime,
//                                        endTime, status}] }
//        <subdir>/<file>.json          full execution: actions[], usageSummary[]
//
// This file is the ONE implementation of that walk. The base64url decode, the
// sha256/32 mapping, the two-level execution walk, the size<100 filter and the
// aborted end-clamp all live here and nowhere else.

import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import type { ScanSink } from "../aggregate";
import type {
  SessionAction,
  SessionDetail,
  SessionHistoryEntry,
  SessionStore,
  WorkspaceListEntry,
} from "./store";
import {
  asArray,
  asRecord,
  num,
  parseJson,
  projectNameFromPath,
  resolveContained,
  str,
} from "../util";

/**
 * Minimum tail after the last action for aborted executions. Covers the user
 * seeing the reply then hitting stop a few seconds later, and stops us
 * clamping to zero when an action lists no emittedAt.
 */
export const ABORTED_TAIL_GRACE_MS = 60_000;

/** Execution files smaller than this are index/lock noise, not executions. */
const MIN_EXEC_FILE_BYTES = 100;

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

export function resolveKiroGlobalStorage(): string {
  if (process.env.KIRO_GLOBAL_STORAGE) return process.env.KIRO_GLOBAL_STORAGE;
  const home = os.homedir();
  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return path.join(appData, "Kiro", "User", "globalStorage", "kiro.kiroagent");
    }
    case "darwin":
      return path.join(
        home, "Library", "Application Support", "Kiro", "User", "globalStorage", "kiro.kiroagent",
      );
    default:
      return path.join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
  }
}

// ---------------------------------------------------------------------------
// Id codec
// ---------------------------------------------------------------------------

/**
 * Tolerant base64url decode for workspace directory names.
 *
 * Kiro truncates some names, so a straight decode yields trailing garbage. We
 * stop at the first byte outside printable ASCII rather than stripping it,
 * because stripping the wrong trailing bytes changes the sha256 and silently
 * points at the wrong execution directory. Falls back to a one-char-shorter
 * variant, then to the raw name.
 */
export function decodeBase64Url(input: string): string {
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
    } catch {
      return null;
    }
  };
  return tryDecode(input) ?? tryDecode(input.slice(0, -1)) ?? input;
}

/** Directory holding a workspace's execution files. */
export function workspaceExecDirName(workspacePath: string): string {
  return crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Record readers
// ---------------------------------------------------------------------------

interface SessionMeta {
  sessionType: string;
  autonomyMode: string;
  model: string;
  title: string;
}

const UNKNOWN_META: SessionMeta = {
  sessionType: "unknown",
  autonomyMode: "unknown",
  model: "unknown",
  title: "",
};

function readJsonFile(file: string): unknown {
  try {
    return parseJson(fs.readFileSync(file, "utf-8"));
  } catch {
    return null;
  }
}

function readSessionMeta(sessionFile: string): SessionMeta {
  const data = asRecord(readJsonFile(sessionFile));
  if (!data) return { ...UNKNOWN_META };
  return {
    sessionType: str(data.sessionType) || "unknown",
    autonomyMode: str(data.autonomyMode) || "unknown",
    model: str(data.selectedModel) || str(data.defaultModelTitle) || "unknown",
    title: str(data.title),
  };
}

/** Sum of usageSummary[].usage. usageSummary is an ARRAY, not an object. */
export function extractCredits(execData: Record<string, unknown> | null): number {
  if (!execData) return 0;
  const summary = execData.usageSummary;
  if (!Array.isArray(summary)) return 0;
  return summary.reduce((sum: number, entry) => sum + num(asRecord(entry)?.usage), 0);
}

function extractActions(execData: Record<string, unknown> | null): SessionAction[] {
  if (!execData) return [];
  return asArray(execData.actions)
    .map((raw) => asRecord(raw))
    .filter((a): a is Record<string, unknown> => {
      if (!a) return false;
      const t = str(a.actionType);
      return t !== "" && t !== "intentClassification" && t !== "model";
    })
    .map((a) => ({
      actionType: str(a.actionType),
      actionState: str(a.actionState),
      input: a.input,
      output: a.output,
    }));
}

/**
 * For status=aborted executions Kiro's endTime lags real activity, often by
 * hours, because it is written when the session is torn down. Prefer the last
 * action's emittedAt plus a small grace tail so wall-clock totals and calendar
 * bars reflect when the agent actually stopped working.
 */
export function effectiveEnd(data: Record<string, unknown>): number {
  const rawEnd = num(data.endTime);
  const rawStart = num(data.startTime);
  if (!rawEnd || !rawStart) return rawEnd;
  const status = str(data.status).toLowerCase();
  if (status !== "aborted" && status !== "user-aborted") return rawEnd;
  let lastAt = 0;
  for (const raw of asArray(data.actions)) {
    const t = num(asRecord(raw)?.emittedAt);
    if (t > lastAt) lastAt = t;
  }
  if (!lastAt) return Math.min(rawEnd, rawStart + ABORTED_TAIL_GRACE_MS);
  const clamped = Math.min(rawEnd, lastAt + ABORTED_TAIL_GRACE_MS);
  return Math.max(rawStart, clamped);
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class KiroFsStore implements SessionStore {
  readonly id = "kiro" as const;
  readonly label = "Kiro IDE (globalStorage)";
  readonly root: string;
  readonly sessionsDir: string;

  /** workspacePath -> executionId -> execution record. */
  private execCache = new Map<string, Map<string, Record<string, unknown>>>();

  constructor(root: string = resolveKiroGlobalStorage()) {
    this.root = root;
    this.sessionsDir = path.join(root, "workspace-sessions");
  }

  isAvailable(): boolean {
    return fs.existsSync(this.sessionsDir);
  }

  async listWorkspaces(): Promise<WorkspaceListEntry[]> {
    if (!fs.existsSync(this.sessionsDir)) return [];
    const out: WorkspaceListEntry[] = [];
    for (const d of fs.readdirSync(this.sessionsDir, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const sessions = asArray(readJsonFile(path.join(this.sessionsDir, d.name, "sessions.json")))
        .map((raw) => asRecord(raw))
        .filter((s): s is Record<string, unknown> => s !== null);
      if (sessions.length === 0) continue;
      const decodedPath = decodeBase64Url(d.name);
      out.push({
        id: d.name,
        path: decodedPath,
        name: projectNameFromPath(decodedPath),
        sessionCount: sessions.length,
        sessions: sessions.map((s) => ({
          id: str(s.sessionId),
          title: str(s.title),
          date: num(s.dateCreated),
        })),
      });
    }
    return out.sort((a, b) => b.sessionCount - a.sessionCount);
  }

  /** Execution records for one workspace, keyed by executionId (cached). */
  private loadExecutions(workspacePath: string): Map<string, Record<string, unknown>> {
    const cached = this.execCache.get(workspacePath);
    if (cached) return cached;
    const map = new Map<string, Record<string, unknown>>();
    const wsDir = path.join(this.root, workspaceExecDirName(workspacePath));
    if (!fs.existsSync(wsDir)) {
      this.execCache.set(workspacePath, map);
      return map;
    }
    for (const filePath of this.walkExecutionFiles(wsDir)) {
      const data = asRecord(readJsonFile(filePath));
      if (data && str(data.executionId) && data.actions) map.set(str(data.executionId), data);
    }
    this.execCache.set(workspacePath, map);
    return map;
  }

  /** Two-level walk: <execDir>/<subdir>/<file>, files >= 100 bytes only. */
  private *walkExecutionFiles(execDir: string): Generator<string> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(execDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(execDir, entry.name);
      let files: string[];
      try {
        files = fs.readdirSync(subDir);
      } catch {
        continue;
      }
      for (const file of files) {
        const filePath = path.join(subDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile() || stat.size < MIN_EXEC_FILE_BYTES) continue;
        } catch {
          continue;
        }
        yield filePath;
      }
    }
  }

  async readSessionDetail(workspaceId: string, sessionId: string): Promise<SessionDetail | null> {
    const sessionFile = resolveContained(this.sessionsDir, workspaceId, `${sessionId}.json`);
    if (!sessionFile) return null;
    const data = asRecord(readJsonFile(sessionFile));
    if (!data) return null;

    const workspacePath = str(data.workspaceDirectory);
    const execMap = this.loadExecutions(workspacePath);

    const history: SessionHistoryEntry[] = asArray(data.history).map((rawEntry) => {
      const h = asRecord(rawEntry) ?? {};
      const msg = asRecord(h.message) ?? {};
      let content = "";
      if (typeof msg.content === "string") {
        content = msg.content;
      } else if (Array.isArray(msg.content)) {
        content = msg.content
          .map((c) => {
            const part = asRecord(c);
            return part && part.type === "text" ? str(part.text) : "";
          })
          .filter(Boolean)
          .join("\n");
      }
      const executionId = str(h.executionId) || null;
      const execData = executionId ? asRecord(execMap.get(executionId)) : null;
      return {
        role: str(msg.role) || "unknown",
        content,
        executionId,
        actions: execData ? extractActions(execData) : [],
        cost: execData ? extractCredits(execData) : 0,
      };
    });

    return {
      sessionId: str(data.sessionId),
      title: str(data.title),
      model: str(data.selectedModel) || str(data.defaultModelTitle),
      autonomyMode: str(data.autonomyMode),
      sessionType: str(data.sessionType),
      // Left undefined (and so omitted from the JSON) when Kiro did not
      // record it, matching the payload the client already handles.
      contextUsage: typeof data.contextUsagePercentage === "number"
        ? data.contextUsagePercentage
        : undefined,
      workspacePath,
      messageCount: history.length,
      totalCost: history.reduce((sum, h) => sum + h.cost, 0),
      history,
    };
  }

  async scan(sink: ScanSink, extraSources: string[] = []): Promise<void> {
    this.scanSource(this.root, this.sessionsDir, sink);
    for (const extra of extraSources) {
      this.scanSource(extra, path.join(extra, "workspace-sessions"), sink);
    }
  }

  private scanSource(sourceBase: string, sourceSessionsDir: string, sink: ScanSink): void {
    if (!fs.existsSync(sourceSessionsDir)) return;
    let dirs: fs.Dirent[];
    try {
      dirs = fs.readdirSync(sourceSessionsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      return;
    }

    for (const d of dirs) {
      const wsFolder = path.join(sourceSessionsDir, d.name);
      const rawSessions = asArray(readJsonFile(path.join(wsFolder, "sessions.json")));
      if (rawSessions.length === 0) continue;
      const sessions = rawSessions
        .map((raw) => asRecord(raw))
        .filter((s): s is Record<string, unknown> => s !== null);

      const decodedPath = decodeBase64Url(d.name);
      const projectName = projectNameFromPath(decodedPath);
      const wsExecDir = path.join(sourceBase, workspaceExecDirName(decodedPath));

      // Counted from the raw index length so a malformed entry still shows up
      // as a session that exists but could not be read.
      sink.countSessions(projectName, rawSessions.length);

      const sessionMeta = new Map<string, SessionMeta>();
      for (const s of sessions) {
        const id = str(s.sessionId);
        if (!id) continue;
        const meta = readSessionMeta(path.join(wsFolder, `${id}.json`));
        if (!meta.title) meta.title = str(s.title);
        sessionMeta.set(id, meta);
        sink.session({
          dateCreated: num(s.dateCreated),
          sessionId: id,
          sessionTitle: meta.title,
          sessionType: meta.sessionType,
          autonomyMode: meta.autonomyMode,
          model: meta.model,
          workspace: projectName,
        });
      }

      if (!fs.existsSync(wsExecDir)) continue;

      // Pass 1 — index files (top-level, non-directory). Fast timing, no
      // session metadata. sessionId is intentionally "" so the dedup merge in
      // the collector fills it from pass 2.
      let indexEntries: fs.Dirent[];
      try {
        indexEntries = fs.readdirSync(wsExecDir, { withFileTypes: true });
      } catch {
        indexEntries = [];
      }
      for (const entry of indexEntries) {
        if (entry.isDirectory()) continue;
        const indexData = asRecord(readJsonFile(path.join(wsExecDir, entry.name)));
        if (!indexData || !Array.isArray(indexData.executions)) continue;
        for (const rawExec of indexData.executions) {
          const exec = asRecord(rawExec);
          if (!exec) continue;
          const start = num(exec.startTime);
          const end = num(exec.endTime);
          if (!start || !end) continue;
          sink.execution({
            start,
            end,
            endRaw: end,
            status: str(exec.status),
            sessionId: "",
            sessionTitle: "",
            sessionType: "unknown",
            autonomyMode: "unknown",
            model: "unknown",
            workspace: projectName,
            executionId: str(exec.executionId).slice(0, 8),
            credits: 0,
          });
        }
      }

      // Pass 2 — full execution files. Supplies chatSessionId, credits,
      // status and the aborted clamp. Unconditional: gating it on the absence
      // of index files left aborted executions unclamped on the live store,
      // putting phantom tails back on the calendar.
      for (const filePath of this.walkExecutionFiles(wsExecDir)) {
        const data = asRecord(readJsonFile(filePath));
        if (!data || !str(data.executionId)) continue;

        const sid = str(data.chatSessionId);
        const meta = sessionMeta.get(sid);
        const credits = extractCredits(data);
        const start = num(data.startTime);
        const rawEnd = num(data.endTime);

        if (start && rawEnd) {
          sink.execution({
            start,
            end: effectiveEnd(data),
            endRaw: rawEnd,
            status: str(data.status),
            sessionId: sid,
            sessionTitle: meta?.title || "",
            sessionType: meta?.sessionType || "unknown",
            autonomyMode: str(data.autonomyMode) || meta?.autonomyMode || "unknown",
            model: meta?.model || "unknown",
            workspace: projectName,
            executionId: str(data.executionId).slice(0, 8),
            credits,
          });
        }

        if (credits > 0) sink.credits(projectName, credits);
      }
    }
  }
}

// KiroCrew store.
//
// Layout (verified 2026-09-08 against a live ~/.kiro/crew):
//
//   <root>/sessions/<stem>.jsonl        one transcript per session
//        line 1  {_type:"metadata", created_at, title, model, agent?,
//                 project?, updated_at?, closed_at?}
//        line n  {role, content, ts, meta}
//        Single lines reach 1.2MB and one transcript reached 4.7MB, so every
//        read here streams line-by-line — never readFileSync on the store.
//        Skipped: *.lock, and the archive/ and .summaries/ subdirectories.
//
//   <root>/usage/tokens/<YYYY-MM-DD>.jsonl   per-turn usage shards
//        {_type:"tokens", ts, slot, provider, model, credits, duration_ms,
//         surface, agent, phase, context_used, context_window}
//
// Domain mapping:
//   workspace  = metadata.project (fallback "default"); unattended slots are
//                grouped under the synthetic workspace "background"
//   session    = one .jsonl file, id = filename stem
//   execution  = one usage row with phase "per_turn" or "session_start",
//                interval [ts - duration_ms, ts]
//   credits    = sum of the per-row credit deltas
//
// phase="" rows are whole-run rollups for subagents, crons and background
// tasks that run CONCURRENTLY with their parents. They are excluded from time
// (they would double-count wall clock — 63h of subagent rollup against 44h of
// real per-turn time in the live store). Their credits ARE counted: no slot in
// the live store carries both a rollup and per-turn rows, so there is nothing
// to double-count, and dropping them would silently lose 18,365 credits of
// real subagent/cron spend.
//
// Tokens and cost are zero throughout this store. They are reported as zero,
// never synthesised.

import fs from "fs";
import os from "os";
import path from "path";
import readline from "readline";
import type { ScanSink } from "../aggregate";
import type {
  SessionAction,
  SessionDetail,
  SessionHistoryEntry,
  SessionStore,
  WorkspaceListEntry,
} from "./store";
import { asRecord, isoToMs, num, parseJson, projectNameFromPath, resolveContained, str } from "../util";

/** Workspace that unattended (subagent / cron / bg) usage is grouped under. */
export const BACKGROUND_WORKSPACE = "background";

/** Workspace for transcripts with no `project` in their metadata. */
export const DEFAULT_WORKSPACE_PATH = "default";

/** Usage phases that describe a real, attributable interval. */
const TIMED_PHASES = new Set(["per_turn", "session_start"]);

const TRANSCRIPT_EXT = ".jsonl";

export function resolveKirocrewRoot(): string {
  if (process.env.KIROCREW_DATA_HOME) return process.env.KIROCREW_DATA_HOME;
  return path.join(os.homedir(), ".kiro", "crew");
}

// ---------------------------------------------------------------------------
// Streaming readers
// ---------------------------------------------------------------------------

/**
 * Yield the file's lines without ever holding more than one line in memory.
 * `limit` stops early (1 = metadata only) and destroys the stream.
 */
async function* readLines(file: string, limit = Infinity): AsyncGenerator<string> {
  let stream: fs.ReadStream;
  try {
    stream = fs.createReadStream(file, { encoding: "utf-8" });
  } catch {
    return;
  }
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  let n = 0;
  try {
    for await (const line of rl) {
      if (line.trim() === "") continue;
      yield line;
      if (++n >= limit) break;
    }
  } finally {
    rl.close();
    stream.destroy();
  }
}

// ---------------------------------------------------------------------------
// Slot classification and joining
// ---------------------------------------------------------------------------

/**
 * Attended = a human was present. Dashboard chats and messaging surfaces are
 * attended; subagents, crons and background maintenance tasks are not.
 */
export function isAttendedSlot(slot: string, surface: string): boolean {
  const s = slot.toLowerCase();
  if (s.startsWith("subagent:") || s.startsWith("bg:") || s.startsWith("_bg")) return false;
  if (s.startsWith("cron:") || s.startsWith("cron-") || s.startsWith("cron_")) return false;
  const sf = surface.toLowerCase();
  if (sf === "subagent" || sf === "cron" || sf.startsWith("bg:") || sf.startsWith("_bg")) {
    return false;
  }
  return true;
}

/**
 * Candidate transcript stems for a usage slot, most specific first.
 *
 *   chat-52-1788588775  -> dashboard_chat-52-1788588775  (suffix join)
 *   cron:33a3319d       -> cron_33a3319d                 (colon -> underscore)
 *   cron-7d94bde0       -> cron_7d94bde0                 (first dash -> underscore)
 */
export function slotStemCandidates(slot: string): string[] {
  const out = [slot];
  if (slot.includes(":")) out.push(slot.replace(/:/g, "_"));
  if (slot.includes("-")) out.push(slot.replace("-", "_"));
  return out;
}

/** The surface prefix of a transcript stem, used as the sessionType facet. */
export function sessionTypeFromStem(stem: string): string {
  const idx = stem.indexOf("_");
  if (idx <= 0) return "chat";
  const prefix = stem.slice(0, idx);
  return prefix || "chat";
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface TranscriptMeta {
  /** Filename stem; also the session id. */
  stem: string;
  file: string;
  title: string;
  model: string;
  agent: string;
  /** metadata.project, or DEFAULT_WORKSPACE_PATH. */
  workspacePath: string;
  /** Display name for the workspace. */
  workspace: string;
  createdAt: number;
  sessionType: string;
}

export class KirocrewStore implements SessionStore {
  readonly id = "kirocrew" as const;
  readonly label = "KiroCrew (sessions + usage shards)";
  readonly root: string;
  readonly sessionsDir: string;
  readonly usageDir: string;

  constructor(root: string = resolveKirocrewRoot()) {
    this.root = root;
    this.sessionsDir = path.join(root, "sessions");
    this.usageDir = path.join(root, "usage", "tokens");
  }

  isAvailable(): boolean {
    return fs.existsSync(this.sessionsDir);
  }

  /** Transcript files: top-level *.jsonl only. Excludes *.lock and subdirs. */
  private transcriptFiles(): string[] {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.sessionsDir, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries
      .filter((e) => e.isFile() && path.extname(e.name) === TRANSCRIPT_EXT)
      .map((e) => path.join(this.sessionsDir, e.name))
      .sort();
  }

  private async readTranscriptMeta(file: string): Promise<TranscriptMeta> {
    const stem = path.basename(file, TRANSCRIPT_EXT);
    let meta: Record<string, unknown> = {};
    for await (const line of readLines(file, 1)) {
      const parsed = asRecord(parseJson(line));
      if (parsed && parsed._type === "metadata") meta = parsed;
      break;
    }
    const workspacePath = str(meta.project) || DEFAULT_WORKSPACE_PATH;
    return {
      stem,
      file,
      title: str(meta.title),
      model: str(meta.model) || "unknown",
      // KiroCrew has no autonomy mode. `agent` is the closest "how it ran"
      // dimension, so it drives that facet rather than leaving it empty.
      agent: str(meta.agent) || "unknown",
      workspacePath,
      workspace: workspacePath === DEFAULT_WORKSPACE_PATH
        ? DEFAULT_WORKSPACE_PATH
        : projectNameFromPath(workspacePath),
      createdAt: isoToMs(meta.created_at),
      sessionType: sessionTypeFromStem(stem),
    };
  }

  private async readAllTranscriptMeta(): Promise<TranscriptMeta[]> {
    const out: TranscriptMeta[] = [];
    for (const file of this.transcriptFiles()) {
      out.push(await this.readTranscriptMeta(file));
    }
    return out;
  }

  async listWorkspaces(): Promise<WorkspaceListEntry[]> {
    const metas = await this.readAllTranscriptMeta();
    const byWorkspace = new Map<string, WorkspaceListEntry>();
    for (const m of metas) {
      let entry = byWorkspace.get(m.workspacePath);
      if (!entry) {
        entry = {
          // base64url of the path, so the id is URL-safe and reversible —
          // same contract as the Kiro store's directory names.
          id: Buffer.from(m.workspacePath, "utf-8").toString("base64url"),
          path: m.workspacePath,
          name: m.workspace,
          sessionCount: 0,
          sessions: [],
        };
        byWorkspace.set(m.workspacePath, entry);
      }
      entry.sessions.push({ id: m.stem, title: m.title, date: m.createdAt });
      entry.sessionCount = entry.sessions.length;
    }
    for (const entry of byWorkspace.values()) {
      entry.sessions.sort((a, b) => b.date - a.date);
    }
    return Array.from(byWorkspace.values()).sort((a, b) => b.sessionCount - a.sessionCount);
  }

  async readSessionDetail(_workspaceId: string, sessionId: string): Promise<SessionDetail | null> {
    const file = resolveContained(this.sessionsDir, `${sessionId}${TRANSCRIPT_EXT}`);
    if (!file || !fs.existsSync(file)) return null;
    const meta = await this.readTranscriptMeta(file);

    const history: SessionHistoryEntry[] = [];
    let first = true;
    for await (const line of readLines(file)) {
      if (first) {
        first = false;
        const head = asRecord(parseJson(line));
        if (head && head._type === "metadata") continue;
      }
      const msg = asRecord(parseJson(line));
      if (!msg) continue;
      if (msg._type === "metadata") continue;
      history.push(messageToHistoryEntry(msg));
    }

    return {
      sessionId: meta.stem,
      title: meta.title,
      model: meta.model,
      autonomyMode: meta.agent,
      sessionType: meta.sessionType,
      workspacePath: meta.workspacePath,
      messageCount: history.length,
      totalCost: history.reduce((sum, h) => sum + h.cost, 0),
      history,
    };
  }

  async scan(sink: ScanSink): Promise<void> {
    const metas = await this.readAllTranscriptMeta();

    // Session rows + per-workspace session counts.
    const perWorkspaceSessions = new Map<string, number>();
    for (const m of metas) {
      perWorkspaceSessions.set(m.workspace, (perWorkspaceSessions.get(m.workspace) || 0) + 1);
      sink.session({
        dateCreated: m.createdAt,
        sessionId: m.stem,
        sessionTitle: m.title,
        sessionType: m.sessionType,
        autonomyMode: m.agent,
        model: m.model,
        workspace: m.workspace,
      });
    }
    for (const [workspace, n] of perWorkspaceSessions) sink.countSessions(workspace, n);

    // Slot -> transcript join tables. Exact stem wins over the
    // suffix-after-first-underscore alias, which can collide.
    const byStem = new Map<string, TranscriptMeta>();
    const bySuffix = new Map<string, TranscriptMeta>();
    for (const m of metas) {
      byStem.set(m.stem, m);
      const idx = m.stem.indexOf("_");
      if (idx > 0) {
        const suffix = m.stem.slice(idx + 1);
        if (!bySuffix.has(suffix)) bySuffix.set(suffix, m);
      }
    }
    const resolveSlot = (slot: string): TranscriptMeta | undefined => {
      for (const candidate of slotStemCandidates(slot)) {
        const exact = byStem.get(candidate);
        if (exact) return exact;
      }
      for (const candidate of slotStemCandidates(slot)) {
        const alias = bySuffix.get(candidate);
        if (alias) return alias;
      }
      return undefined;
    };

    await this.scanUsage(sink, resolveSlot);
  }

  private async scanUsage(
    sink: ScanSink,
    resolveSlot: (slot: string) => TranscriptMeta | undefined,
  ): Promise<void> {
    let shards: string[];
    try {
      shards = fs
        .readdirSync(this.usageDir, { withFileTypes: true })
        .filter((e) => e.isFile() && path.extname(e.name) === TRANSCRIPT_EXT)
        .map((e) => path.join(this.usageDir, e.name))
        .sort();
    } catch {
      return;
    }

    for (const shard of shards) {
      for await (const line of readLines(shard)) {
        const row = asRecord(parseJson(line));
        if (!row || row._type !== "tokens") continue;

        const slot = str(row.slot);
        const surface = str(row.surface);
        const phase = str(row.phase);
        const credits = num(row.credits);
        const attended = isAttendedSlot(slot, surface);
        const session = attended ? resolveSlot(slot) : undefined;
        const workspace = session ? session.workspace : BACKGROUND_WORKSPACE;

        // Credits are additive per-row deltas — counted for every row,
        // including the phase="" rollups that carry all subagent/cron spend.
        if (credits > 0) sink.credits(workspace, credits);

        if (!TIMED_PHASES.has(phase)) continue;

        const end = isoToMs(row.ts);
        const durationMs = num(row.duration_ms);
        if (!end || !(durationMs > 0)) continue;
        const start = end - durationMs;

        sink.execution({
          start,
          end,
          endRaw: end,
          status: phase,
          sessionId: session?.stem || "",
          sessionTitle: session?.title || "",
          sessionType: session?.sessionType || surface || "unknown",
          autonomyMode: session?.agent || str(row.agent) || "unknown",
          model: str(row.model) || session?.model || "unknown",
          workspace,
          // Stable across shards and rescans: one usage row per (slot, ts).
          executionId: `${slot}@${end}`,
          credits,
        });
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Message mapping
// ---------------------------------------------------------------------------

/** meta.input / meta.output are JSON-encoded STRINGS. Decode when possible. */
function decodeMetaPayload(value: unknown): unknown {
  if (typeof value !== "string") return value;
  if (value === "") return "";
  const parsed = parseJson(value);
  return parsed === null ? value : parsed;
}

function messageToHistoryEntry(msg: Record<string, unknown>): SessionHistoryEntry {
  const meta = asRecord(msg.meta) ?? {};
  let content = "";
  if (typeof msg.content === "string") {
    content = msg.content;
  } else if (Array.isArray(msg.content)) {
    content = msg.content
      .map((c) => {
        if (typeof c === "string") return c;
        const part = asRecord(c);
        return part && part.type === "text" ? str(part.text) : "";
      })
      .filter(Boolean)
      .join("\n");
  }

  const actions: SessionAction[] = [];
  if (str(msg.role) === "tool" || meta.tool_call_id !== undefined) {
    actions.push({
      actionType: str(meta.purpose) || str(msg.role) || "tool",
      actionState: meta.done === true ? "done" : "",
      input: decodeMetaPayload(meta.input),
      output: decodeMetaPayload(meta.output),
    });
  }

  const turnStats = asRecord(meta.turn_stats);
  return {
    role: str(msg.role) || "unknown",
    content,
    executionId: str(meta.mid) || null,
    actions,
    cost: turnStats ? num(turnStats.credits) : 0,
  };
}

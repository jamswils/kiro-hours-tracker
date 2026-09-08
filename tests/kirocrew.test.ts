import { describe, expect, it } from "vitest";
import {
  BACKGROUND_WORKSPACE,
  KirocrewStore,
  isAttendedSlot,
  sessionTypeFromStem,
  slotStemCandidates,
} from "../server/stores/kirocrew";
import { KIROCREW_FIXTURE_ROOT, execById, scanStore, workspaceByName } from "./helpers";

const store = new KirocrewStore(KIROCREW_FIXTURE_ROOT);

// Fixture usage shard (tests/fixtures/kirocrew/usage/tokens/2026-01-01.jsonl):
//   session_start chat-1-100      00:05:00  duration "30000"  credits "1.5"
//   per_turn      chat-1-100      00:10:00  duration 60000    credits 2.5
//   phase=""      subagent:abc123 00:20:00  duration 7200000  credits 10
//   per_turn      cron-deadbeef   01:00:00  duration 120000   credits 3
//   per_turn      chat-1-100      01:05:00  duration 0        credits 0.25
//   _type != tokens, and one non-JSON line
const TURN_END = Date.parse("2026-01-01T00:10:00.000Z");
const START_END = Date.parse("2026-01-01T00:05:00.000Z");
const CRON_END = Date.parse("2026-01-01T01:00:00.000Z");

describe("kirocrew slot handling", () => {
  it("treats dashboard and messaging slots as attended", () => {
    expect(isAttendedSlot("chat-52-1788588775", "dashboard")).toBe(true);
    expect(isAttendedSlot("telegram_kirocrew_direct_123", "telegram")).toBe(true);
  });

  it("treats subagent, cron and background slots as unattended", () => {
    expect(isAttendedSlot("subagent:fb30a081", "subagent")).toBe(false);
    expect(isAttendedSlot("cron:2bc852b9:ba0e51cd", "cron")).toBe(false);
    expect(isAttendedSlot("cron-7d94bde0", "cron")).toBe(false);
    expect(isAttendedSlot("_bg:tips", "bg:tips")).toBe(false);
    // Surface alone is enough, even for an unrecognised slot shape.
    expect(isAttendedSlot("weird-slot", "subagent")).toBe(false);
  });

  it("offers the stem candidates that join a slot to a transcript", () => {
    expect(slotStemCandidates("chat-52-1788588775")).toContain("chat-52-1788588775");
    expect(slotStemCandidates("cron:33a3319d")).toContain("cron_33a3319d");
    expect(slotStemCandidates("cron-7d94bde0")).toContain("cron_7d94bde0");
  });

  it("derives the session type from the transcript stem prefix", () => {
    expect(sessionTypeFromStem("dashboard_chat-52-1788588775")).toBe("dashboard");
    expect(sessionTypeFromStem("cron_33a3319d")).toBe("cron");
    expect(sessionTypeFromStem("telegram_kirocrew_direct_1")).toBe("telegram");
    expect(sessionTypeFromStem("bare-stem")).toBe("chat");
  });
});

describe("kirocrew store against the fixture", () => {
  it("reports itself available", () => {
    expect(store.isAvailable()).toBe(true);
    expect(store.id).toBe("kirocrew");
  });

  it("lists one workspace per transcript project, defaulting when absent", async () => {
    const workspaces = await store.listWorkspaces();
    const names = workspaces.map((w) => w.name).sort();
    expect(names).toEqual(["default", "fixture-project"]);
    const project = workspaces.find((w) => w.name === "fixture-project");
    expect(project?.path).toBe("/tmp/fixture-project");
    expect(project?.sessions.map((s) => s.id)).toEqual(["dashboard_chat-1-100"]);
    expect(project?.sessions[0].title).toBe("Fixture chat");
    // The workspace id round-trips through base64url.
    expect(Buffer.from(project?.id ?? "", "base64url").toString("utf-8"))
      .toBe("/tmp/fixture-project");
  });

  it("skips lock files, the archive directory and the summaries sidecar", async () => {
    const workspaces = await store.listWorkspaces();
    const paths = workspaces.map((w) => w.path);
    expect(paths).not.toContain("/tmp/should-never-appear");
    expect(paths).not.toContain("/tmp/should-never-appear-archive");
    // Two transcripts only: the chat and the metadata-only cron.
    expect(workspaces.reduce((n, w) => n + w.sessionCount, 0)).toBe(2);
  });

  it("counts the metadata-only transcript as a session with no executions", async () => {
    const result = await scanStore(store);
    expect(result.totalSessions).toBe(2);
    const cron = result.sessions.find((s) => s.sessionId === "cron_deadbeef");
    expect(cron).toBeDefined();
    expect(cron?.workspace).toBe("default");
    expect(cron?.model).toBe("model-crew-2");
    expect(cron?.sessionType).toBe("cron");
    expect(workspaceByName(result, "default")?.executions).toBe(0);
  });

  it("maps per_turn and session_start rows to intervals ending at ts", async () => {
    const result = await scanStore(store);
    const turn = execById(result, `chat-1-100@${TURN_END}`);
    expect(turn).toBeDefined();
    expect(turn?.start).toBe(TURN_END - 60_000);
    expect(turn?.end).toBe(TURN_END);
    expect(turn?.status).toBe("per_turn");
    expect(turn?.workspace).toBe("fixture-project");
    expect(turn?.sessionId).toBe("dashboard_chat-1-100");
    expect(turn?.model).toBe("model-crew-1");
  });

  it("coerces string-typed numerics on the session_start row", async () => {
    const result = await scanStore(store);
    const boot = execById(result, `chat-1-100@${START_END}`);
    expect(boot).toBeDefined();
    // duration_ms arrived as the string "30000".
    expect(boot?.end).toBe(START_END);
    expect(boot?.start).toBe(START_END - 30_000);
    // credits arrived as the string "1.5".
    expect(boot?.credits).toBeCloseTo(1.5, 6);
  });

  it("excludes phase='' rollups from time totals", async () => {
    const result = await scanStore(store);
    // The 2h subagent rollup must not appear as an execution at all.
    expect(result.executions.some((e) => e.executionId.startsWith("subagent:"))).toBe(false);
    expect(result.executions.some((e) => e.end - e.start === 7_200_000)).toBe(false);
    // 30s + 60s attended + 120s unattended cron, nothing else.
    expect(result.totalExecutions).toBe(3);
    expect(result.totalExecTimeMs).toBe(210_000);
    expect(result.totalTimeMs).toBe(210_000);
    expect(result.peakParallelActive).toBe(1);
  });

  it("still counts the rollup's credits, under the background workspace", async () => {
    const result = await scanStore(store);
    // 1.5 + 2.5 + 10 + 3 + 0.25
    expect(result.totalCredits).toBeCloseTo(17.25, 6);
    const background = workspaceByName(result, BACKGROUND_WORKSPACE);
    expect(background?.credits).toBeCloseTo(13, 6); // 10 rollup + 3 cron
    expect(workspaceByName(result, "fixture-project")?.credits).toBeCloseTo(4.25, 6);
  });

  it("groups unattended slots under the background workspace", async () => {
    const result = await scanStore(store);
    const cron = execById(result, `cron-deadbeef@${CRON_END}`);
    expect(cron?.workspace).toBe(BACKGROUND_WORKSPACE);
    // Unattended: not joined to the cron_deadbeef transcript even though a
    // matching stem exists.
    expect(cron?.sessionId).toBe("");
    expect(workspaceByName(result, BACKGROUND_WORKSPACE)?.executions).toBe(1);
  });

  it("skips zero-duration, wrong-_type and unparseable usage rows", async () => {
    const result = await scanStore(store);
    // The duration_ms=0 row contributes credits but no interval.
    expect(execById(result, `chat-1-100@${Date.parse("2026-01-01T01:05:00.000Z")}`))
      .toBeUndefined();
    // The _type != tokens row would have added 999 credits / 999999ms.
    expect(result.totalCredits).toBeLessThan(100);
    expect(result.executions.every((e) => e.end - e.start > 0)).toBe(true);
  });

  it("does not fabricate tokens or cost", async () => {
    const result = await scanStore(store);
    // Credits are the only spend signal in this store; nothing else is
    // synthesised, so every row's credits trace to a usage record.
    const summed = result.executions.reduce((n, e) => n + e.credits, 0);
    expect(summed).toBeCloseTo(1.5 + 2.5 + 3, 6);
  });

  it("reads a transcript's messages, decoding the JSON-string tool payloads", async () => {
    const detail = await store.readSessionDetail("ignored", "dashboard_chat-1-100");
    expect(detail).not.toBeNull();
    expect(detail?.title).toBe("Fixture chat");
    expect(detail?.model).toBe("model-crew-1");
    expect(detail?.autonomyMode).toBe("kirocrew");
    expect(detail?.workspacePath).toBe("/tmp/fixture-project");
    // 4 messages; the metadata line is not a message.
    expect(detail?.messageCount).toBe(4);

    const toolMsg = detail?.history.find((h) => h.role === "tool");
    expect(toolMsg?.actions).toHaveLength(1);
    expect(toolMsg?.actions[0].actionType).toBe("Count rows in the shard");
    expect(toolMsg?.actions[0].actionState).toBe("done");
    expect(toolMsg?.actions[0].input).toEqual({ path: "/tmp/fixture-project/rows.csv" });
    expect(toolMsg?.actions[0].output).toEqual({ rows: 42 });

    // turn_stats.credits is the per-turn cost.
    expect(detail?.totalCost).toBeCloseTo(2.5, 6);
  });

  it("returns null for a missing session and for traversal attempts", async () => {
    expect(await store.readSessionDetail("ignored", "no-such-session")).toBeNull();
    expect(await store.readSessionDetail("ignored", "../../package")).toBeNull();
  });
});

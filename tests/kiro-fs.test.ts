import { describe, expect, it } from "vitest";
import {
  ABORTED_TAIL_GRACE_MS,
  KiroFsStore,
  decodeBase64Url,
  effectiveEnd,
  extractCredits,
  workspaceExecDirName,
} from "../server/stores/kiro-fs";
import {
  KIRO_FIXTURE_WORKSPACE_ID,
  KIRO_FIXTURE_WORKSPACE_NAME,
  KIRO_FIXTURE_WORKSPACE_PATH,
  KIRO_FIXTURE_ROOT,
  execById,
  scanStore,
  workspaceByName,
} from "./helpers";

// Fixture timeline (epoch ms):
//   exec aaaaaaaa1111  succeed  start 1700000000000  end 1700000600000
//   exec bbbbbbbb2222  aborted  start 1700000300000  endTime 1700007200000
//                               last action emittedAt 1700000900000
const T0 = 1_700_000_000_000;
const LAST_ABORTED_ACTION = 1_700_000_900_000;

describe("kiro-fs id codec", () => {
  it("decodes the fixture workspace directory name to its real path", () => {
    expect(decodeBase64Url(KIRO_FIXTURE_WORKSPACE_ID)).toBe(KIRO_FIXTURE_WORKSPACE_PATH);
  });

  it("maps the decoded path to the fixture's execution directory", () => {
    expect(workspaceExecDirName(KIRO_FIXTURE_WORKSPACE_PATH))
      .toBe("b72c31fdb682dc7a73966bcc6609a712");
  });

  it("falls back to the raw name for undecodable input", () => {
    // Not valid base64url content; must not throw and must not return "".
    expect(decodeBase64Url("!!!")).toBeTypeOf("string");
  });
});

describe("kiro-fs effectiveEnd", () => {
  it("leaves a successful execution's end alone", () => {
    expect(effectiveEnd({ status: "succeed", startTime: T0, endTime: T0 + 600_000 }))
      .toBe(T0 + 600_000);
  });

  it("clamps an aborted execution to the last action + the grace tail", () => {
    const end = effectiveEnd({
      status: "aborted",
      startTime: T0,
      endTime: T0 + 7_200_000,
      actions: [{ emittedAt: T0 + 100_000 }, { emittedAt: T0 + 900_000 }],
    });
    expect(end).toBe(T0 + 900_000 + ABORTED_TAIL_GRACE_MS);
  });

  it("clamps to start + grace when an aborted execution has no action timestamps", () => {
    expect(effectiveEnd({ status: "user-aborted", startTime: T0, endTime: T0 + 7_200_000 }))
      .toBe(T0 + ABORTED_TAIL_GRACE_MS);
  });

  it("never returns an end before the start", () => {
    const end = effectiveEnd({
      status: "aborted",
      startTime: T0 + 500_000,
      endTime: T0 + 600_000,
      actions: [{ emittedAt: T0 }],
    });
    expect(end).toBeGreaterThanOrEqual(T0 + 500_000);
  });
});

describe("kiro-fs extractCredits", () => {
  it("sums usageSummary[].usage (an ARRAY, not an object)", () => {
    expect(extractCredits({ usageSummary: [{ usage: 1.5 }, { usage: 0.5 }] })).toBe(2);
  });

  it("returns 0 when usageSummary is not an array", () => {
    expect(extractCredits({ usageSummary: { usage: 9 } })).toBe(0);
    expect(extractCredits({})).toBe(0);
  });
});

describe("kiro-fs store against the fixture", () => {
  const store = new KiroFsStore(KIRO_FIXTURE_ROOT);

  it("reports itself available", () => {
    expect(store.isAvailable()).toBe(true);
    expect(store.id).toBe("kiro");
  });

  it("lists the fixture workspace with both sessions", async () => {
    const workspaces = await store.listWorkspaces();
    expect(workspaces).toHaveLength(1);
    expect(workspaces[0].id).toBe(KIRO_FIXTURE_WORKSPACE_ID);
    expect(workspaces[0].path).toBe(KIRO_FIXTURE_WORKSPACE_PATH);
    expect(workspaces[0].name).toBe(KIRO_FIXTURE_WORKSPACE_NAME);
    expect(workspaces[0].sessionCount).toBe(2);
    expect(workspaces[0].sessions.map((s) => s.id).sort())
      .toEqual(["sess-alpha", "sess-beta"]);
  });

  it("finds both executions and attaches session metadata", async () => {
    const result = await scanStore(store);
    expect(result.totalSessions).toBe(2);
    expect(result.totalExecutions).toBe(2);

    const alpha = execById(result, "aaaaaaaa");
    expect(alpha).toBeDefined();
    expect(alpha?.sessionId).toBe("sess-alpha");
    expect(alpha?.sessionType).toBe("chat");
    expect(alpha?.autonomyMode).toBe("autopilot");
    expect(alpha?.model).toBe("model-x");
    expect(alpha?.workspace).toBe(KIRO_FIXTURE_WORKSPACE_NAME);

    const beta = execById(result, "bbbbbbbb");
    expect(beta?.sessionId).toBe("sess-beta");
    expect(beta?.model).toBe("model-y");
  });

  it("clamps the aborted execution's active end while preserving endRaw", async () => {
    const result = await scanStore(store);
    const beta = execById(result, "bbbbbbbb");
    // The index pass supplied the raw end; the full-file pass must win.
    expect(beta?.end).toBe(LAST_ABORTED_ACTION + ABORTED_TAIL_GRACE_MS);
    expect(beta?.endRaw).toBe(1_700_007_200_000);
    expect(beta?.status).toBe("aborted");
  });

  it("computes active and raw totals from the deduped rows", async () => {
    const result = await scanStore(store);
    // active: [0,600k] and [300k,960k] -> merged 960k, summed 600k + 660k
    expect(result.totalTimeMs).toBe(960_000);
    expect(result.totalExecTimeMs).toBe(1_260_000);
    // raw: [0,600k] and [300k,7.2M] -> merged 7.2M
    expect(result.totalTimeMsRaw).toBe(7_200_000);
    expect(result.peakParallelActive).toBe(2);
    expect(result.peakParallelRaw).toBe(2);
  });

  it("sums credits from usageSummary once, not once per pass", async () => {
    const result = await scanStore(store);
    expect(result.totalCredits).toBeCloseTo(5.25, 6);
    expect(workspaceByName(result, KIRO_FIXTURE_WORKSPACE_NAME)?.credits).toBeCloseTo(5.25, 6);
    expect(workspaceByName(result, KIRO_FIXTURE_WORKSPACE_NAME)?.executions).toBe(2);
  });

  it("facets the sessions by type, autonomy mode and model", async () => {
    const result = await scanStore(store);
    expect(result.facets.sessionType).toEqual({ chat: 1, spec: 1 });
    expect(result.facets.autonomyMode).toEqual({ autopilot: 1, supervised: 1 });
    expect(result.facets.model).toEqual({ "model-x": 1, "model-y": 1 });
  });

  it("reads a session's history, actions and cost", async () => {
    const detail = await store.readSessionDetail(KIRO_FIXTURE_WORKSPACE_ID, "sess-alpha");
    expect(detail).not.toBeNull();
    expect(detail?.title).toBe("Alpha session");
    expect(detail?.model).toBe("model-x");
    expect(detail?.contextUsage).toBe(41);
    expect(detail?.messageCount).toBe(2);
    // Array content is flattened to its text parts only.
    expect(detail?.history[1].content).toBe("Here they are.\nTwo files.");
    // intentClassification actions are filtered out of the transcript view.
    expect(detail?.history[0].actions.map((a) => a.actionType))
      .toEqual(["fsRead", "executeBash"]);
    expect(detail?.history[0].cost).toBeCloseTo(2, 6);
  });

  it("returns null for a session that does not exist", async () => {
    expect(await store.readSessionDetail(KIRO_FIXTURE_WORKSPACE_ID, "no-such-session")).toBeNull();
  });
});

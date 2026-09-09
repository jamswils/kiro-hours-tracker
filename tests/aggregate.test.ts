import { describe, expect, it } from "vitest";
import {
  LONG_EXECUTION_MS,
  createScanCollector,
  mergeIntervalsMs,
  peakParallel,
  splitIntervalByDay,
} from "../server/aggregate";
import type { ExecutionRow } from "../server/types";

function exec(partial: Partial<ExecutionRow> & { start: number; end: number }): ExecutionRow {
  return {
    endRaw: partial.end,
    status: "succeed",
    sessionId: "s1",
    sessionTitle: "t",
    sessionType: "chat",
    autonomyMode: "autopilot",
    model: "m",
    workspace: "ws",
    executionId: "e1",
    credits: 0,
    ...partial,
  };
}

describe("mergeIntervalsMs", () => {
  it("returns 0 for no intervals", () => {
    expect(mergeIntervalsMs([])).toBe(0);
  });

  it("sums disjoint intervals", () => {
    expect(mergeIntervalsMs([[0, 100], [200, 350]])).toBe(250);
  });

  it("counts overlapping intervals once", () => {
    // 0..100 and 50..200 cover 0..200
    expect(mergeIntervalsMs([[0, 100], [50, 200]])).toBe(200);
  });

  it("handles a fully contained interval", () => {
    expect(mergeIntervalsMs([[0, 1000], [100, 200]])).toBe(1000);
  });

  it("joins intervals that touch exactly", () => {
    expect(mergeIntervalsMs([[0, 100], [100, 200]])).toBe(200);
  });

  it("is order independent", () => {
    const a = mergeIntervalsMs([[500, 600], [0, 100], [50, 200]]);
    const b = mergeIntervalsMs([[0, 100], [50, 200], [500, 600]]);
    expect(a).toBe(b);
    expect(a).toBe(300);
  });
});

describe("peakParallel", () => {
  it("returns 0 for no intervals", () => {
    expect(peakParallel([])).toBe(0);
  });

  it("returns 1 for disjoint intervals", () => {
    expect(peakParallel([[0, 100], [200, 300]])).toBe(1);
  });

  it("counts simultaneous executions", () => {
    expect(peakParallel([[0, 100], [10, 90], [20, 30]])).toBe(3);
  });

  it("does not count a handover as parallel", () => {
    // Ends are processed before starts at the same instant.
    expect(peakParallel([[0, 100], [100, 200]])).toBe(1);
  });

  it("reports the maximum, not the final, concurrency", () => {
    expect(peakParallel([[0, 50], [10, 20], [10, 20], [100, 200]])).toBe(3);
  });
});

describe("splitIntervalByDay", () => {
  const midnight = Date.UTC(2026, 0, 2); // 2026-01-02T00:00:00Z

  it("returns a single segment for an interval inside one day", () => {
    const segs = splitIntervalByDay(midnight + 3_600_000, midnight + 7_200_000);
    expect(segs).toHaveLength(1);
    expect(segs[0].day).toBe("2026-01-02");
  });

  it("splits across midnight and the segments sum to the original span", () => {
    const start = midnight - 2 * 3_600_000; // 22:00 on the 1st
    const end = midnight + 3 * 3_600_000; // 03:00 on the 2nd
    const segs = splitIntervalByDay(start, end);
    expect(segs.map((s) => s.day)).toEqual(["2026-01-01", "2026-01-02"]);
    const summed = segs.reduce((sum, s) => sum + (s.end - s.start), 0);
    expect(summed).toBe(end - start);
    // Contiguous, no gaps or overlaps.
    expect(segs[0].start).toBe(start);
    expect(segs[0].end).toBe(midnight);
    expect(segs[1].start).toBe(midnight);
    expect(segs[1].end).toBe(end);
  });

  it("splits a multi-day span into one segment per day summing to the span", () => {
    const start = midnight + 3_600_000;
    const end = midnight + 3 * 86_400_000 + 7_200_000;
    const segs = splitIntervalByDay(start, end);
    expect(segs).toHaveLength(4);
    expect(segs.reduce((sum, s) => sum + (s.end - s.start), 0)).toBe(end - start);
    expect(segs.map((s) => s.day))
      .toEqual(["2026-01-02", "2026-01-03", "2026-01-04", "2026-01-05"]);
  });

  it("honours a timezone offset when choosing the day boundary", () => {
    // 23:30 UTC on the 1st is 07:30 on the 2nd at UTC+8, so no split there,
    // and the day label is the local one.
    const start = midnight - 30 * 60_000;
    const end = midnight + 30 * 60_000;
    const segs = splitIntervalByDay(start, end, 8 * 60);
    expect(segs).toHaveLength(1);
    expect(segs[0].day).toBe("2026-01-02");
    expect(segs[0].end - segs[0].start).toBe(end - start);
  });

  it("returns nothing for an empty or inverted span", () => {
    expect(splitIntervalByDay(midnight, midnight)).toEqual([]);
    expect(splitIntervalByDay(midnight + 1000, midnight)).toEqual([]);
  });
});

describe("createScanCollector", () => {
  it("merges overlapping executions into wall clock and peak parallelism", () => {
    const { sink, finalize } = createScanCollector();
    sink.countSessions("ws", 2);
    sink.execution(exec({ executionId: "a", start: 0, end: 100_000 }));
    sink.execution(exec({ executionId: "b", start: 50_000, end: 200_000 }));
    const result = finalize();
    expect(result.totalExecutions).toBe(2);
    expect(result.totalTimeMs).toBe(200_000); // merged
    expect(result.totalExecTimeMs).toBe(250_000); // summed
    expect(result.peakParallelActive).toBe(2);
    expect(result.totalSessions).toBe(2);
    expect(result.workspaces[0]).toMatchObject({ name: "ws", sessions: 2, executions: 2 });
  });

  it("dedups on workspace|executionId and lets the tighter end win", () => {
    const { sink, finalize } = createScanCollector();
    // Pass 1: index row — loose end, no session metadata.
    sink.execution(exec({
      executionId: "a", start: 0, end: 900_000, endRaw: 900_000,
      sessionId: "", sessionTitle: "", sessionType: "unknown",
      autonomyMode: "unknown", model: "unknown", status: "",
    }));
    // Pass 2: full file — clamped end, real metadata.
    sink.execution(exec({
      executionId: "a", start: 0, end: 60_000, endRaw: 900_000,
      sessionId: "sess-1", sessionTitle: "Real title", sessionType: "chat",
      autonomyMode: "autopilot", model: "model-x", status: "aborted", credits: 4,
    }));
    const result = finalize();
    expect(result.totalExecutions).toBe(1);
    const row = result.executions[0];
    expect(row.end).toBe(60_000);
    expect(row.endRaw).toBe(900_000);
    expect(row.sessionId).toBe("sess-1");
    expect(row.sessionTitle).toBe("Real title");
    expect(row.model).toBe("model-x");
    expect(row.status).toBe("aborted");
    expect(row.credits).toBe(4);
    expect(result.totalTimeMs).toBe(60_000);
    expect(result.totalTimeMsRaw).toBe(900_000);
  });

  it("keeps the same executionId in different workspaces separate", () => {
    const { sink, finalize } = createScanCollector();
    sink.execution(exec({ executionId: "a", workspace: "ws1", start: 0, end: 1000 }));
    sink.execution(exec({ executionId: "a", workspace: "ws2", start: 0, end: 1000 }));
    expect(finalize().totalExecutions).toBe(2);
  });

  it("accumulates credits per workspace without touching time", () => {
    const { sink, finalize } = createScanCollector();
    sink.credits("ws1", 2.5);
    sink.credits("ws1", 1.5);
    sink.credits("ws2", 10);
    const result = finalize();
    expect(result.totalCredits).toBe(14);
    expect(result.workspaces.find((w) => w.name === "ws1")?.credits).toBe(4);
    expect(result.workspaces.find((w) => w.name === "ws2")?.credits).toBe(10);
    expect(result.totalTimeMs).toBe(0);
  });

  it("lists executions over the audit threshold without excluding them", () => {
    const { sink, finalize } = createScanCollector();
    const long = LONG_EXECUTION_MS + 60_000;
    sink.execution(exec({ executionId: "long", start: 0, end: long, endRaw: long }));
    const result = finalize();
    expect(result.longExecutions).toHaveLength(1);
    expect(result.longExecutions?.[0].durationMs).toBe(long);
    expect(result.totalExecTimeMs).toBe(long);
  });

  it("sorts executions by start and sessions by creation date", () => {
    const { sink, finalize } = createScanCollector();
    sink.execution(exec({ executionId: "late", start: 5000, end: 6000 }));
    sink.execution(exec({ executionId: "early", start: 1000, end: 2000 }));
    sink.session({
      dateCreated: 9000, sessionId: "s-late", sessionTitle: "", sessionType: "chat",
      autonomyMode: "a", model: "m", workspace: "ws",
    });
    sink.session({
      dateCreated: 1000, sessionId: "s-early", sessionTitle: "", sessionType: "chat",
      autonomyMode: "a", model: "m", workspace: "ws",
    });
    const result = finalize();
    expect(result.executions.map((e) => e.executionId)).toEqual(["early", "late"]);
    expect(result.sessions.map((s) => s.sessionId)).toEqual(["s-early", "s-late"]);
  });
});

import express from "express";
import cors from "cors";
import fs from "fs";
import path from "path";
import { execFile } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";
import { selectStore } from "./stores/select";
import type { DashboardResult, ScanResult } from "./types";

const app = express();
// CORS: only needed when the UI is served from a different origin (Vite dev
// server without the /api proxy). Scoped to explicit localhost origins —
// never a wildcard, because responses contain full session transcripts.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: ALLOWED_ORIGINS }));

// ---------------------------------------------------------------------------
// Store selection
// ---------------------------------------------------------------------------
// All layout knowledge lives behind the store seam (server/stores/). Set
// KIRO_STORE=kiro|kirocrew|auto to choose; see server/stores/select.ts.
const store = selectStore();
console.log(
  `[kiro-sessions-inspector] platform=${process.platform} store=${store.id} ` +
  `root=${store.root} available=${store.isAvailable()}`,
);

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: store.isAvailable(),
    platform: process.platform,
    store: store.id,
    storeLabel: store.label,
    // Retained under their original names so existing clients keep working;
    // for the KiroCrew store these are its root and sessions directory.
    globalStorage: store.root,
    sessionsDir: store.sessionsDir,
  });
});

// ---------------------------------------------------------------------------
// /api/workspaces — lightweight: session index only, no execution files
// ---------------------------------------------------------------------------
app.get("/api/workspaces", async (_req, res) => {
  try {
    res.json(await store.listWorkspaces());
  } catch (e) {
    console.error("[/api/workspaces] error:", e instanceof Error ? e.message : String(e));
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// /api/workspaces/:workspaceId/sessions/:sessionId
// ---------------------------------------------------------------------------
// Both params come from the URL. The store's readSessionDetail resolves them
// through resolveContained() and returns null for anything that escapes its
// root, so `..` segments cannot turn this into an arbitrary file read.
app.get("/api/workspaces/:workspaceId/sessions/:sessionId", async (req, res) => {
  const { workspaceId, sessionId } = req.params;
  try {
    const detail = await store.readSessionDetail(workspaceId, sessionId);
    if (!detail) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    res.json(detail);
  } catch {
    res.status(404).json({ error: "Session not found" });
  }
});

// ---------------------------------------------------------------------------
// /api/dashboard — served from a cache refreshed by the scan subprocess
// ---------------------------------------------------------------------------
const EMPTY_SCAN: ScanResult = {
  totalTimeMs: 0, totalExecTimeMs: 0, totalTimeMsRaw: 0, totalExecTimeMsRaw: 0,
  peakParallelActive: 0, peakParallelRaw: 0,
  totalSessions: 0, totalExecutions: 0, totalCredits: 0,
  executions: [], sessions: [], workspaces: [], workspacesRaw: [],
  facets: { sessionType: {}, autonomyMode: {}, model: {} },
  longExecutions: [],
};

let dashboardCache: DashboardResult = { ...EMPTY_SCAN, lastUpdated: 0, scanning: false };
let dashboardScanning = false;

function triggerDashboardScan() {
  if (dashboardScanning) return;
  dashboardScanning = true;
  dashboardCache.scanning = true;

  const serverDir = path.dirname(fileURLToPath(import.meta.url));
  const workerPath = path.join(serverDir, "scan-worker.ts");
  const projectDir = path.dirname(serverDir);

  // Extra sources are additional roots in the store's own layout (exported
  // archives). Only the Kiro store has any; the KiroCrew adapter ignores them.
  const extraSources = (process.env.KIRO_EXTRA_SOURCES || "").split(";").filter(Boolean);
  if (store.id === "kiro") {
    const workspaceRoot = path.dirname(path.dirname(projectDir));
    const possibleExports = [
      path.join(projectDir, "KiroData-Export(1)", "KiroData-Export"),
      path.join(workspaceRoot, "kiro-sessions-inspector", "KiroData-Export(1)", "KiroData-Export"),
    ];
    for (const exportPath of possibleExports) {
      if (fs.existsSync(exportPath) && !extraSources.includes(exportPath)) {
        extraSources.push(exportPath);
      }
    }
  }

  // Resolve tsx register path for the subprocess.
  // pathToFileURL produces a valid file:/// URL on every platform — the old
  // `file://${path}` template emitted file://C:/... on Windows, which Node's
  // ESM loader rejects, silently leaving the dashboard at zeros.
  const tsxRegister = path.join(projectDir, "node_modules", "tsx", "dist", "loader.mjs");
  const rawArgs = [
    "--import", pathToFileURL(tsxRegister).href,
    workerPath, `--store=${store.id}`, ...extraSources,
  ];
  console.log(
    `[dashboard] starting scan subprocess store=${store.id} ` +
    `with ${extraSources.length} extra source(s)`,
  );
  const child = execFile(process.execPath, rawArgs, { maxBuffer: 200 * 1024 * 1024 }, (err, stdout, stderr) => {
    dashboardScanning = false;
    dashboardCache.scanning = false;
    if (err) {
      console.error("[dashboard] scan subprocess error:", err.message);
      if (stderr) console.error("[dashboard] stderr:", stderr.slice(0, 500));
      return;
    }
    try {
      const result = JSON.parse(stdout) as ScanResult;
      dashboardCache = { ...result, lastUpdated: Date.now(), scanning: false };
      console.log(
        `[dashboard] scan complete: ${result.totalSessions} sessions, ` +
        `${result.totalExecutions} execs, ${Math.round(result.totalTimeMs / 60000)}min total, ` +
        `${result.totalCredits.toFixed(1)} credits`,
      );
    } catch (e) {
      console.error(
        "[dashboard] failed to parse scan result:",
        e instanceof Error ? e.message : String(e),
      );
    }
  });
  child.on("error", (e) => {
    console.error("[dashboard] scan subprocess spawn failed:", e.message);
    dashboardScanning = false;
    dashboardCache.scanning = false;
  });
}

// Start first scan on boot (non-blocking, deferred to let the server bind first)
setTimeout(() => {
  try { triggerDashboardScan(); }
  catch (e) {
    console.error("[dashboard] boot scan failed:", e instanceof Error ? e.message : String(e));
  }
}, 1000);

app.get("/api/dashboard", (_req, res) => {
  if (Date.now() - dashboardCache.lastUpdated > 30_000) {
    triggerDashboardScan();
  }
  res.json(dashboardCache);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const PORT = Number(process.env.PORT) || 3001;
// Bind loopback ONLY. Responses carry full session transcripts and tool
// output; this must never be reachable from the network. Set HOST explicitly
// if you genuinely need otherwise.
const HOST = process.env.HOST || "127.0.0.1";
app.listen(PORT, HOST, () => console.log(`Server running on http://${HOST}:${PORT}`));

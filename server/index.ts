import express from "express";
import cors from "cors";
import fs from "fs";
import os from "os";
import path from "path";
import crypto from "crypto";
import { execFile } from "child_process";
import { fileURLToPath, pathToFileURL } from "url";

const app = express();
// CORS: only needed when the UI is served from a different origin (Vite dev
// server without the /api proxy). Scoped to explicit localhost origins —
// never a wildcard, because responses contain full session transcripts.
const ALLOWED_ORIGINS = (process.env.CORS_ORIGINS || "http://localhost:5173,http://127.0.0.1:5173")
  .split(",").map((s) => s.trim()).filter(Boolean);
app.use(cors({ origin: ALLOWED_ORIGINS }));

// ---------------------------------------------------------------------------
// Platform-aware path resolution
// ---------------------------------------------------------------------------
function resolveGlobalStorage(): string {
  if (process.env.KIRO_GLOBAL_STORAGE) return process.env.KIRO_GLOBAL_STORAGE;
  const home = os.homedir();
  switch (process.platform) {
    case "win32": {
      const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
      return path.join(appData, "Kiro", "User", "globalStorage", "kiro.kiroagent");
    }
    case "darwin":
      return path.join(home, "Library", "Application Support", "Kiro", "User", "globalStorage", "kiro.kiroagent");
    default:
      return path.join(home, ".config", "Kiro", "User", "globalStorage", "kiro.kiroagent");
  }
}

const GLOBAL_STORAGE = resolveGlobalStorage();
const SESSIONS_DIR = path.join(GLOBAL_STORAGE, "workspace-sessions");
console.log(`[kiro-sessions-inspector] platform=${process.platform} globalStorage=${GLOBAL_STORAGE}`);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
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
    } catch {
      return null;
    }
  };
  return tryDecode(str) ?? tryDecode(str.slice(0, -1)) ?? str;
}

function projectNameFromPath(decodedPath: string): string {
  return decodedPath.split(/[\\/]/).filter(Boolean).pop() || decodedPath;
}

function extractCost(executionData: any): number {
  const summary = executionData?.usageSummary;
  if (!Array.isArray(summary)) return 0;
  return summary.reduce((sum: number, s: any) => sum + (s.usage || 0), 0);
}

function extractActions(executionData: any): any[] {
  if (!executionData?.actions) return [];
  return executionData.actions
    .filter((a: any) => {
      const t = a.actionType;
      return t && t !== "intentClassification" && t !== "model";
    })
    .map((a: any) => ({
      actionType: a.actionType,
      actionState: a.actionState,
      input: a.input,
      output: a.output,
    }));
}

// ---------------------------------------------------------------------------
// /api/health
// ---------------------------------------------------------------------------
app.get("/api/health", (_req, res) => {
  res.json({
    ok: fs.existsSync(SESSIONS_DIR),
    platform: process.platform,
    globalStorage: GLOBAL_STORAGE,
    sessionsDir: SESSIONS_DIR,
  });
});

// ---------------------------------------------------------------------------
// /api/workspaces — lightweight, reads only sessions.json per workspace
// ---------------------------------------------------------------------------
app.get("/api/workspaces", (_req, res) => {
  if (!fs.existsSync(SESSIONS_DIR)) return res.json([]);
  try {
    const dirs = fs.readdirSync(SESSIONS_DIR, { withFileTypes: true });
    const workspaces = dirs
      .filter((d) => d.isDirectory())
      .map((d) => {
        const sessionsFile = path.join(SESSIONS_DIR, d.name, "sessions.json");
        let sessions: { sessionId: string; title: string; dateCreated: string }[] = [];
        try { sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf-8")); } catch { return null; }
        if (!Array.isArray(sessions) || sessions.length === 0) return null;
        const decodedPath = decodeBase64Url(d.name);
        const projectName = projectNameFromPath(decodedPath);
        return {
          id: d.name,
          path: decodedPath,
          name: projectName,
          sessionCount: sessions.length,
          sessions: sessions.map((s) => ({
            id: s.sessionId,
            title: s.title,
            date: Number(s.dateCreated),
          })),
        };
      })
      .filter(Boolean)
      .sort((a: any, b: any) => b.sessionCount - a.sessionCount);
    res.json(workspaces);
  } catch (e: any) {
    console.error("[/api/workspaces] error:", e.message);
    res.json([]);
  }
});

// ---------------------------------------------------------------------------
// /api/workspaces/:workspaceId/sessions/:sessionId
// On-demand, loads execution files for one workspace only (cached)
// ---------------------------------------------------------------------------
const executionCache = new Map<string, Map<string, any>>();

function loadExecutionsForWorkspace(workspacePath: string): Map<string, any> {
  if (executionCache.has(workspacePath)) return executionCache.get(workspacePath)!;
  const map = new Map<string, any>();
  const wsHash = crypto.createHash("sha256").update(workspacePath).digest("hex").slice(0, 32);
  const wsDir = path.join(GLOBAL_STORAGE, wsHash);
  if (!fs.existsSync(wsDir)) { executionCache.set(workspacePath, map); return map; }
  try {
    for (const entry of fs.readdirSync(wsDir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const subDir = path.join(wsDir, entry.name);
      let files: string[];
      try { files = fs.readdirSync(subDir); } catch { continue; }
      for (const file of files) {
        const filePath = path.join(subDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (!stat.isFile() || stat.size < 100) continue;
          const data = JSON.parse(fs.readFileSync(filePath, "utf-8"));
          if (data.executionId && data.actions) map.set(data.executionId, data);
        } catch {}
      }
    }
  } catch {}
  executionCache.set(workspacePath, map);
  return map;
}

app.get("/api/workspaces/:workspaceId/sessions/:sessionId", (req, res) => {
  const { workspaceId, sessionId } = req.params;
  // Containment: both params come from the URL. Resolve the final path and
  // require it to stay inside SESSIONS_DIR — otherwise `..` segments give
  // arbitrary file read of any *.json on the machine.
  const sessionFile = path.resolve(SESSIONS_DIR, workspaceId, `${sessionId}.json`);
  if (!sessionFile.startsWith(path.resolve(SESSIONS_DIR) + path.sep)) {
    res.status(400).json({ error: "Invalid session path" });
    return;
  }
  try {
    const data = JSON.parse(fs.readFileSync(sessionFile, "utf-8"));
    const workspacePath = data.workspaceDirectory || "";
    const execMap = loadExecutionsForWorkspace(workspacePath);

    const history = (data.history || []).map((h: any) => {
      const msg = h.message || {};
      let content = "";
      if (typeof msg.content === "string") content = msg.content;
      else if (Array.isArray(msg.content)) {
        content = msg.content.map((c: any) => c.type === "text" ? c.text : "").filter(Boolean).join("\n");
      }
      const executionId = h.executionId || null;
      let actions: any[] = [];
      let cost = 0;
      if (executionId) {
        const execData = execMap.get(executionId);
        if (execData) { actions = extractActions(execData); cost = extractCost(execData); }
      }
      return { role: msg.role || "unknown", content, executionId, actions, cost };
    });

    res.json({
      sessionId: data.sessionId,
      title: data.title,
      model: data.selectedModel || data.defaultModelTitle,
      autonomyMode: data.autonomyMode,
      sessionType: data.sessionType,
      contextUsage: data.contextUsagePercentage,
      workspacePath,
      messageCount: history.length,
      totalCost: history.reduce((sum: number, h: any) => sum + (h.cost || 0), 0),
      history,
    });
  } catch {
    res.status(404).json({ error: "Session not found" });
  }
});

// ---------------------------------------------------------------------------
// /api/dashboard — uses lightweight execution INDEX files for time/duration
// data instead of scanning every individual execution file.
// ---------------------------------------------------------------------------
interface ExecutionRow {
  start: number;
  end: number;
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

interface Facets {
  sessionType: Record<string, number>;
  autonomyMode: Record<string, number>;
  model: Record<string, number>;
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

interface DashboardResult {
  totalTimeMs: number;
  totalExecTimeMs: number;
  totalSessions: number;
  totalExecutions: number;
  totalCredits: number;
  executions: ExecutionRow[];
  sessions: SessionRow[];
  workspaces: { name: string; sessions: number; executions: number; timeMs: number; credits: number }[];
  facets: Facets;
  longExecutions?: LongExecution[];
  lastUpdated: number;
  scanning: boolean;
}

let dashboardCache: DashboardResult = {
  totalTimeMs: 0, totalExecTimeMs: 0, totalSessions: 0, totalExecutions: 0, totalCredits: 0,
  executions: [], sessions: [], workspaces: [],
  facets: { sessionType: {}, autonomyMode: {}, model: {} },
  longExecutions: [],
  lastUpdated: 0, scanning: false,
};
let dashboardScanning = false;

function triggerDashboardScan() {
  if (dashboardScanning) return;
  dashboardScanning = true;
  dashboardCache.scanning = true;

  const workerPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "scan-worker.ts");
  const extraSources = (process.env.KIRO_EXTRA_SOURCES || "").split(";").filter(Boolean);
  // Auto-detect exported data in common locations
  const projectDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const workspaceRoot = path.dirname(path.dirname(projectDir)); // two levels up from the project dir
  const possibleExports = [
    path.join(projectDir, "KiroData-Export(1)", "KiroData-Export"),
    path.join(workspaceRoot, "kiro-sessions-inspector", "KiroData-Export(1)", "KiroData-Export"),
  ];
  for (const exportPath of possibleExports) {
    if (fs.existsSync(exportPath) && !extraSources.includes(exportPath)) {
      extraSources.push(exportPath);
    }
  }

  // Resolve tsx register path for the subprocess.
  // pathToFileURL produces a valid file:/// URL on every platform — the old
  // `file://${path}` template emitted file://C:/... on Windows, which Node's
  // ESM loader rejects, silently leaving the dashboard at zeros.
  const tsxRegister = path.join(projectDir, "node_modules", "tsx", "dist", "loader.mjs");
  const rawArgs = [
    "--import", pathToFileURL(tsxRegister).href,
    workerPath, GLOBAL_STORAGE, SESSIONS_DIR, ...extraSources
  ];
  console.log(`[dashboard] starting scan subprocess with ${extraSources.length} extra source(s)`);
  const child = execFile(process.execPath, rawArgs, { maxBuffer: 50 * 1024 * 1024 }, (err, stdout, stderr) => {
    if (err) {
      console.error("[dashboard] scan subprocess error:", err.message);
      if (stderr) console.error("[dashboard] stderr:", stderr.slice(0, 500));
      dashboardScanning = false;
      dashboardCache.scanning = false;
      return;
    }
    try {
      const result = JSON.parse(stdout);
      if (result) {
        dashboardCache = {
          ...result,
          lastUpdated: Date.now(),
          scanning: false,
        };
        console.log(`[dashboard] scan complete: ${result.totalSessions} sessions, ${result.totalExecutions} execs, ${Math.round(result.totalTimeMs / 60000)}min total, ${result.totalCredits.toFixed(1)} credits`);
      }
    } catch (e: any) {
      console.error("[dashboard] failed to parse scan result:", e.message);
    }
    dashboardScanning = false;
    dashboardCache.scanning = false;
  });
}

// Start first scan on boot (non-blocking, deferred to let the server bind first)
setTimeout(() => {
  try { triggerDashboardScan(); }
  catch (e: any) { console.error("[dashboard] boot scan failed:", e.message); }
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

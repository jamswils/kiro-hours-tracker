// Independent cross-check of /api/dashboard output. Reads live + export
// stores, computes active & raw totals + peak concurrency, fetches the
// running server, and asserts the two agree within tolerance.
//
// Run with: node scripts/verify-scan.mjs  (or `npm run verify`)
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";

const LIVE_GLOBAL = process.env.KIRO_GLOBAL_STORAGE
  || path.join(
    process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"),
    "Kiro", "User", "globalStorage", "kiro.kiroagent",
  );
const EXPORT_CANDIDATES = [
  path.resolve(process.cwd(), "KiroData-Export(1)", "KiroData-Export"),
  path.resolve(process.cwd(), "..", "..", "kiro-sessions-inspector", "KiroData-Export(1)", "KiroData-Export"),
];

function decodeB64(s) {
  // Matches server/scan-worker.ts decodeBase64Url: try first decode, break on
  // first non-printable, fall back to sliced variant. The naive
  // .replace(/[^\x20-\x7e]/g, "") approach strips the wrong trailing bytes
  // on some workspaces and produces a different sha256 hash, so the
  // verifier would report false-positive mismatches.
  const tryDecode = (s) => {
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
  return tryDecode(s) ?? tryDecode(s.slice(0, -1)) ?? s;
}

function effectiveEnd(data) {
  const rawEnd = Number(data.endTime || 0);
  const rawStart = Number(data.startTime || 0);
  if (!rawEnd || !rawStart) return rawEnd;
  const status = String(data.status || "").toLowerCase();
  if (status !== "aborted" && status !== "user-aborted") return rawEnd;
  const actions = Array.isArray(data.actions) ? data.actions : [];
  let lastAt = 0;
  for (const a of actions) { const t = Number(a?.emittedAt || 0); if (t > lastAt) lastAt = t; }
  if (!lastAt) return Math.min(rawEnd, rawStart + 60_000);
  return Math.max(rawStart, Math.min(rawEnd, lastAt + 60_000));
}

function mergeIntervals(list) {
  if (!list.length) return 0;
  const s = list.slice().sort((a, b) => a[0] - b[0]);
  let total = 0, curS = s[0][0], curE = s[0][1];
  for (let i = 1; i < s.length; i++) {
    const [a, b] = s[i];
    if (a <= curE) { if (b > curE) curE = b; }
    else { total += curE - curS; curS = a; curE = b; }
  }
  return total + (curE - curS);
}

function peakParallel(list) {
  if (!list.length) return 0;
  const events = [];
  for (const [a, b] of list) { events.push([a, 1]); events.push([b, -1]); }
  events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let peak = 0, cur = 0;
  for (const [, d] of events) { cur += d; if (cur > peak) peak = cur; }
  return peak;
}

function scanSource(GLOBAL, label, out, seen) {
  if (!fs.existsSync(GLOBAL)) return;
  const SESSIONS_DIR = path.join(GLOBAL, "workspace-sessions");
  if (!fs.existsSync(SESSIONS_DIR)) return;

  // Only count workspaces that still have a non-empty sessions.json — matches
  // the server's scanSource which skips empties. Orphaned hash dirs
  // (old workspaces with no sessions list) would otherwise inflate our
  // local count and cause a false-positive mismatch.
  const liveHashes = new Set();
  const hashToName = new Map();
  for (const f of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
    if (!f.isDirectory()) continue;
    const sessionsFile = path.join(SESSIONS_DIR, f.name, "sessions.json");
    let sessions;
    try { sessions = JSON.parse(fs.readFileSync(sessionsFile, "utf8")); }
    catch { continue; }
    if (!Array.isArray(sessions) || sessions.length === 0) continue;
    const decoded = decodeB64(f.name);
    const hash = crypto.createHash("sha256").update(decoded).digest("hex").slice(0, 32);
    liveHashes.add(hash);
    hashToName.set(hash, decoded.split(/[\\/]/).filter(Boolean).pop() || decoded);
  }

  for (const d of fs.readdirSync(GLOBAL, { withFileTypes: true })) {
    if (!d.isDirectory() || d.name === "workspace-sessions") continue;
    if (!liveHashes.has(d.name)) continue;
    const wsName = hashToName.get(d.name);
    const execDir = path.join(GLOBAL, d.name);
    let entries;
    try { entries = fs.readdirSync(execDir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const subDir = path.join(execDir, e.name);
      let files; try { files = fs.readdirSync(subDir); } catch { continue; }
      for (const f of files) {
        const fp = path.join(subDir, f);
        let data; try { data = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
        if (!data.executionId || !data.startTime || !data.endTime) continue;
        const key = wsName + "|" + String(data.executionId).slice(0, 8);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          source: label, ws: wsName, eid: String(data.executionId).slice(0, 8),
          status: String(data.status || ""),
          start: Number(data.startTime),
          endRaw: Number(data.endTime),
          endActive: effectiveEnd(data),
        });
      }
    }
    for (const e of entries) {
      if (e.isDirectory()) continue;
      const fp = path.join(execDir, e.name);
      let idx; try { idx = JSON.parse(fs.readFileSync(fp, "utf8")); } catch { continue; }
      if (!Array.isArray(idx.executions)) continue;
      for (const x of idx.executions) {
        if (!x.startTime || !x.endTime) continue;
        const key = wsName + "|" + String(x.executionId || "").slice(0, 8);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({
          source: label, ws: wsName, eid: String(x.executionId || "").slice(0, 8),
          status: String(x.status || ""),
          start: Number(x.startTime),
          endRaw: Number(x.endTime),
          endActive: Number(x.endTime),
        });
      }
    }
  }
}

function fmtH(ms) { return (ms / 3_600_000).toFixed(2) + "h"; }

const execs = [];
const seen = new Set();
scanSource(LIVE_GLOBAL, "live", execs, seen);
for (const c of EXPORT_CANDIDATES) if (fs.existsSync(c)) scanSource(c, "export", execs, seen);

const sessTimeRaw = execs.reduce((s, e) => s + (e.endRaw - e.start), 0);
const sessTimeActive = execs.reduce((s, e) => s + Math.max(0, e.endActive - e.start), 0);
const wallRaw = mergeIntervals(execs.map(e => [e.start, e.endRaw]));
const wallActive = mergeIntervals(execs.map(e => [e.start, Math.max(e.start, e.endActive)]));
const peakRaw = peakParallel(execs.map(e => [e.start, e.endRaw]));
const peakAct = peakParallel(execs.map(e => [e.start, Math.max(e.start, e.endActive)]));

console.log("Local rescan:");
console.log("  execs:                ", execs.length);
console.log("  sessTime raw/active:  ", fmtH(sessTimeRaw), "/", fmtH(sessTimeActive));
console.log("  wallClock raw/active: ", fmtH(wallRaw), "/", fmtH(wallActive));
console.log("  peak parallel R/A:    ", peakRaw, "/", peakAct);

let res = null;
try { res = await fetch("http://localhost:3001/api/dashboard"); } catch { /* ignore */ }
if (!res) {
  console.log("\nServer not reachable. Start it with `npm run start` then re-run.");
  process.exit(0);
}
const d = await res.json();
console.log("\nServer /api/dashboard:");
console.log("  totalExecutions:      ", d.totalExecutions);
console.log("  totalExecTimeMs raw/A:", fmtH(d.totalExecTimeMsRaw || 0), "/", fmtH(d.totalExecTimeMs));
console.log("  totalTimeMs raw/A:    ", fmtH(d.totalTimeMsRaw || 0), "/", fmtH(d.totalTimeMs));
console.log("  peakParallel raw/A:   ", d.peakParallelRaw || 0, "/", d.peakParallelActive || 0);

function near(a, b, tolMs = 60_000) { return Math.abs(a - b) <= tolMs; }
const mismatches = [];
if (!near(sessTimeRaw, d.totalExecTimeMsRaw || 0)) mismatches.push("sessTime raw differs by " + fmtH(Math.abs(sessTimeRaw - (d.totalExecTimeMsRaw || 0))));
if (!near(sessTimeActive, d.totalExecTimeMs)) mismatches.push("sessTime active differs by " + fmtH(Math.abs(sessTimeActive - d.totalExecTimeMs)));
if (!near(wallRaw, d.totalTimeMsRaw || 0)) mismatches.push("wallClock raw differs by " + fmtH(Math.abs(wallRaw - (d.totalTimeMsRaw || 0))));
if (!near(wallActive, d.totalTimeMs)) mismatches.push("wallClock active differs by " + fmtH(Math.abs(wallActive - d.totalTimeMs)));
if (peakRaw !== (d.peakParallelRaw || 0)) mismatches.push("peakRaw " + peakRaw + " vs " + (d.peakParallelRaw || 0));
if (peakAct !== (d.peakParallelActive || 0)) mismatches.push("peakActive " + peakAct + " vs " + (d.peakParallelActive || 0));

if (mismatches.length) {
  console.log("\n*** Mismatches ***");
  for (const m of mismatches) console.log("  " + m);
  process.exit(1);
}
console.log("\nAll totals match within tolerance.");

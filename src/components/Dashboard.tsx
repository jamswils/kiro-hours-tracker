import { Fragment, useEffect, useMemo, useState } from "react";
import {
  Clock, Activity, Layers, FolderOpen, TrendingUp, Calendar, Coins,
  ChevronDown, ChevronRight, AlertTriangle, Moon, CalendarDays, CalendarRange,
  LayoutGrid, Settings2, Globe,
} from "lucide-react";
import { clsx } from "clsx";

// ---------------------------------------------------------------------------
// Types — mirror server/scan-worker.ts output (raw UTC timestamps + metadata).
// Every timezone-dependent computation happens in this file so the same
// payload can drive any user's configured timezone without a server rescan.
// ---------------------------------------------------------------------------
interface ExecutionRow {
  start: number;             // UTC ms
  end: number;               // UTC ms — active end (aborted sessions clamped)
  endRaw?: number;           // UTC ms — raw endTime from Kiro, no clamping
  status?: string;           // "succeed" | "aborted" | "user-aborted" | ""
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
  dateCreated: number;       // UTC ms
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

interface DashboardData {
  totalTimeMs: number;          // merged wall clock, active (clamped) ends
  totalExecTimeMs: number;      // sum of durations, active (clamped) ends
  totalTimeMsRaw?: number;      // merged wall clock, raw endTime
  totalExecTimeMsRaw?: number;  // sum of durations, raw endTime
  peakParallelActive?: number;  // peak parallel execs using active ends
  peakParallelRaw?: number;     // peak parallel execs using raw ends
  totalSessions: number;
  totalExecutions: number;
  totalCredits: number;
  executions: ExecutionRow[];
  sessions: SessionRow[];
  workspaces: { name: string; sessions: number; executions: number; timeMs: number; credits: number }[];
  workspacesRaw?: { name: string; sessions: number; executions: number; timeMs: number; credits: number }[];
  facets?: Facets;
  longExecutions?: LongExecution[];
  lastUpdated: number;
  scanning: boolean;
}

// ---------------------------------------------------------------------------
// Preferences (persisted to localStorage)
// ---------------------------------------------------------------------------
const API = "http://localhost:3001/api";
const HOURS_THRESHOLD = 10;
const DAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DAY_FULL = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SCHEDULE_STORAGE_KEY = "kiro-inspector-schedule-v2";
const CALENDAR_PREF_KEY = "kiro-inspector-calendar-v1";

interface WorkSchedule {
  workDays: boolean[]; // [Sun..Sat]
  startHour: number;   // 0..23
  endHour: number;     // 1..24
  timezone: string;    // IANA zone, e.g. "Australia/Perth"
  locale: string;      // e.g. "en-AU", "en-US", "en-GB"
}

function detectBrowserTimezone(): string {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"; }
  catch { return "UTC"; }
}

function detectBrowserLocale(): string {
  try { return navigator.language || "en-US"; } catch { return "en-US"; }
}

const DEFAULT_SCHEDULE: WorkSchedule = {
  workDays: [false, true, true, true, true, true, false], // Mon–Fri
  startHour: 8,
  endHour: 18,
  timezone: detectBrowserTimezone(),
  locale: detectBrowserLocale(),
};

function loadSchedule(): WorkSchedule {
  try {
    const raw = localStorage.getItem(SCHEDULE_STORAGE_KEY);
    if (!raw) return DEFAULT_SCHEDULE;
    const p = JSON.parse(raw);
    if (
      Array.isArray(p.workDays) && p.workDays.length === 7 &&
      typeof p.startHour === "number" && typeof p.endHour === "number"
    ) {
      return {
        workDays: p.workDays,
        startHour: p.startHour,
        endHour: p.endHour,
        timezone: typeof p.timezone === "string" && p.timezone ? p.timezone : detectBrowserTimezone(),
        locale: typeof p.locale === "string" && p.locale ? p.locale : detectBrowserLocale(),
      };
    }
  } catch {}
  return DEFAULT_SCHEDULE;
}

function saveSchedule(s: WorkSchedule) {
  try { localStorage.setItem(SCHEDULE_STORAGE_KEY, JSON.stringify(s)); } catch {}
}

// A short list of popular IANA zones for the picker. Users can also type any
// IANA zone name directly; the free-text field validates via Intl.DateTimeFormat.
const COMMON_TIMEZONES: { region: string; zones: string[] }[] = [
  { region: "Pacific / Australia", zones: [
    "Australia/Perth", "Australia/Sydney", "Australia/Melbourne", "Australia/Brisbane", "Australia/Adelaide",
    "Pacific/Auckland", "Pacific/Honolulu",
  ]},
  { region: "Asia", zones: [
    "Asia/Singapore", "Asia/Tokyo", "Asia/Hong_Kong", "Asia/Shanghai", "Asia/Seoul",
    "Asia/Kolkata", "Asia/Bangkok", "Asia/Dubai", "Asia/Jakarta",
  ]},
  { region: "Europe / Africa", zones: [
    "Europe/London", "Europe/Dublin", "Europe/Paris", "Europe/Berlin", "Europe/Madrid",
    "Europe/Amsterdam", "Europe/Stockholm", "Europe/Warsaw", "Europe/Istanbul",
    "Europe/Moscow", "Africa/Johannesburg", "Africa/Cairo",
  ]},
  { region: "Americas", zones: [
    "America/New_York", "America/Chicago", "America/Denver", "America/Los_Angeles",
    "America/Toronto", "America/Vancouver", "America/Mexico_City",
    "America/Sao_Paulo", "America/Buenos_Aires",
  ]},
  { region: "UTC", zones: ["UTC"] },
];

function isValidTimezone(tz: string): boolean {
  try { new Intl.DateTimeFormat("en-US", { timeZone: tz }).format(Date.now()); return true; }
  catch { return false; }
}

// ---------------------------------------------------------------------------
// Timezone math (works for any IANA zone, handles DST automatically)
// ---------------------------------------------------------------------------
function tzOffsetMinutes(tz: string, ts: number): number {
  const d = new Date(ts);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  }).formatToParts(d);
  const get = (t: string) => Number(parts.find(p => p.type === t)?.value || 0);
  const asUtc = Date.UTC(
    get("year"), get("month") - 1, get("day"),
    get("hour") === 24 ? 0 : get("hour"), get("minute"), get("second"),
  );
  return Math.round((asUtc - d.getTime()) / 60_000);
}

function tzParts(tz: string, ts: number) {
  const offsetMin = tzOffsetMinutes(tz, ts);
  const shifted = new Date(ts + offsetMin * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth(),
    day: shifted.getUTCDate(),
    weekday: shifted.getUTCDay(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
  };
}

function tzDateKey(tz: string, ts: number): string {
  const p = tzParts(tz, ts);
  return `${p.year}-${String(p.month + 1).padStart(2, "0")}-${String(p.day).padStart(2, "0")}`;
}

function tzTodayKey(tz: string): string {
  return tzDateKey(tz, Date.now());
}

function formatTimeInTz(ts: number, tz: string, locale: string): string {
  if (!ts) return "—";
  try {
    return new Intl.DateTimeFormat(locale, { timeZone: tz, hour: "2-digit", minute: "2-digit", hour12: true }).format(ts);
  } catch {
    return new Date(ts).toISOString().slice(11, 16);
  }
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------
function formatDuration(ms: number): string {
  if (ms <= 0) return "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes}m`;
  return `${hours}h ${minutes}m`;
}

function formatHours(ms: number): string {
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.round(ms / 60_000)}m`;
  return `${hours.toFixed(1)}h`;
}

function formatHourLabel(h: number): string {
  if (h === 0) return "12 AM";
  if (h === 12) return "12 PM";
  if (h === 24) return "12 AM (next day)";
  if (h < 12) return `${h} AM`;
  return `${h - 12} PM`;
}

// ---------------------------------------------------------------------------
// Core aggregation: bucket raw executions into per-day stats in the user's tz.
// ---------------------------------------------------------------------------
interface DailyStats {
  date: string;            // YYYY-MM-DD in configured tz
  weekday: number;         // 0-6 (Sunday=0)
  sessionCount: number;
  executionCount: number;
  credits: number;
  timeMs: number;          // merged wall-clock (intervals clipped to day)
  execTimeMs: number;      // sum of durations clipped to day
  insideMs: number;
  outsideMs: number;
  firstStart: number;
  lastEnd: number;
  maxParallel: number;
  executions: ExecutionRow[];
}

function tzDayBoundariesUtc(tz: string, dateKey: string): [number, number] {
  const [y, m, d] = dateKey.split("-").map(Number);
  const guessMs = Date.UTC(y, m - 1, d);
  const offsetMin = tzOffsetMinutes(tz, guessMs);
  const startMs = guessMs - offsetMin * 60_000;
  return [startMs, startMs + 86_400_000];
}

function maxParallelFor(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  const events: { time: number; type: number }[] = [];
  for (const [s, e] of intervals) {
    events.push({ time: s, type: 1 });
    events.push({ time: e, type: -1 });
  }
  events.sort((a, b) => a.time - b.time || a.type - b.type);
  let active = 0;
  let maxP = 0;
  for (const ev of events) {
    active += ev.type;
    if (active > maxP) maxP = active;
  }
  return maxP;
}

function mergedDurationMs(intervals: [number, number][]): number {
  if (intervals.length === 0) return 0;
  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  let total = 0;
  let cs = sorted[0][0];
  let ce = sorted[0][1];
  for (let i = 1; i < sorted.length; i++) {
    const [s, e] = sorted[i];
    if (s <= ce) { if (e > ce) ce = e; }
    else { total += ce - cs; cs = s; ce = e; }
  }
  return total + (ce - cs);
}

function splitByTzDay(startMs: number, endMs: number, tz: string): { day: string; start: number; end: number }[] {
  const out: { day: string; start: number; end: number }[] = [];
  if (endMs <= startMs) return out;
  let cursor = startMs;
  while (cursor < endMs) {
    const parts = tzParts(tz, cursor);
    const dayKey = `${parts.year}-${String(parts.month + 1).padStart(2, "0")}-${String(parts.day).padStart(2, "0")}`;
    const [, dayEndMs] = tzDayBoundariesUtc(tz, dayKey);
    const chunkEnd = Math.min(dayEndMs, endMs);
    out.push({ day: dayKey, start: cursor, end: chunkEnd });
    cursor = chunkEnd;
  }
  return out;
}

function splitByScheduleInDay(startMs: number, endMs: number, tz: string, schedule: WorkSchedule): { insideMs: number; outsideMs: number } {
  let inside = 0;
  let outside = 0;
  let cursor = startMs;
  while (cursor < endMs) {
    const parts = tzParts(tz, cursor);
    const hourOffsetMs = parts.minute * 60_000;
    const hourEndMs = cursor + (60 * 60_000 - hourOffsetMs);
    const chunkEnd = Math.min(hourEndMs, endMs);
    const chunkMs = chunkEnd - cursor;
    const isWorkDay = schedule.workDays[parts.weekday];
    const isWorkHour = parts.hour >= schedule.startHour && parts.hour < schedule.endHour;
    if (isWorkDay && isWorkHour) inside += chunkMs;
    else outside += chunkMs;
    cursor = chunkEnd;
  }
  return { insideMs: inside, outsideMs: outside };
}

function computeDailyStats(
  executions: ExecutionRow[],
  sessions: SessionRow[],
  schedule: WorkSchedule,
): Map<string, DailyStats> {
  const byDay = new Map<string, DailyStats>();
  const tz = schedule.timezone;

  const ensure = (date: string): DailyStats => {
    let d = byDay.get(date);
    if (!d) {
      const [y, m, day] = date.split("-").map(Number);
      const weekday = new Date(y, m - 1, day).getDay();
      d = {
        date, weekday,
        sessionCount: 0, executionCount: 0, credits: 0,
        timeMs: 0, execTimeMs: 0,
        insideMs: 0, outsideMs: 0,
        firstStart: 0, lastEnd: 0, maxParallel: 0,
        executions: [],
      };
      byDay.set(date, d);
    }
    return d;
  };

  for (const s of sessions) {
    const d = ensure(tzDateKey(tz, s.dateCreated));
    d.sessionCount++;
  }

  const intervalsByDay = new Map<string, [number, number][]>();
  for (const e of executions) {
    const segs = splitByTzDay(e.start, e.end, tz);
    for (const seg of segs) {
      const list = intervalsByDay.get(seg.day) || [];
      list.push([seg.start, seg.end]);
      intervalsByDay.set(seg.day, list);
      const d = ensure(seg.day);
      d.executionCount++;
    }
    if (segs.length > 0) {
      ensure(segs[0].day).executions.push(e);
      if (e.credits > 0) ensure(segs[0].day).credits += e.credits;
    }
  }

  for (const [date, intervals] of intervalsByDay.entries()) {
    const d = ensure(date);
    const [dayStartMs, dayEndMs] = tzDayBoundariesUtc(tz, date);
    const clipped: [number, number][] = [];
    let execTimeMs = 0;
    for (const [s, e] of intervals) {
      const cs = Math.max(s, dayStartMs);
      const ce = Math.min(e, dayEndMs);
      if (ce > cs) {
        clipped.push([cs, ce]);
        execTimeMs += ce - cs;
      }
    }
    d.execTimeMs = execTimeMs;
    d.timeMs = mergedDurationMs(clipped);
    d.maxParallel = maxParallelFor(clipped);
    d.firstStart = clipped.length > 0 ? Math.min(...clipped.map(x => x[0])) : 0;
    d.lastEnd = clipped.length > 0 ? Math.max(...clipped.map(x => x[1])) : 0;

    // Inside/outside on the MERGED intervals.
    const sortedClipped = clipped.slice().sort((a, b) => a[0] - b[0]);
    const merged: [number, number][] = [];
    for (const [s, e] of sortedClipped) {
      const last = merged[merged.length - 1];
      if (last && s <= last[1]) { if (e > last[1]) last[1] = e; } else merged.push([s, e]);
    }
    for (const [s, e] of merged) {
      const split = splitByScheduleInDay(s, e, tz, schedule);
      d.insideMs += split.insideMs;
      d.outsideMs += split.outsideMs;
    }
  }

  return byDay;
}

// ---------------------------------------------------------------------------
// Heat map builder (tz-aware)
// ---------------------------------------------------------------------------
function buildCalendar(dailyMap: Map<string, DailyStats>, months: number, tz: string): DailyStats[][] {
  const todayKey = tzTodayKey(tz);
  const [ty, tm, td] = todayKey.split("-").map(Number);
  const today = new Date(ty, tm - 1, td);
  const startDate = new Date(today);
  startDate.setMonth(startDate.getMonth() - months);
  startDate.setDate(startDate.getDate() - startDate.getDay());

  const weeks: DailyStats[][] = [];
  let currentWeek: DailyStats[] = [];
  const cursor = new Date(startDate);

  while (cursor <= today) {
    const y = cursor.getFullYear();
    const m = String(cursor.getMonth() + 1).padStart(2, "0");
    const d = String(cursor.getDate()).padStart(2, "0");
    const key = `${y}-${m}-${d}`;
    const entry = dailyMap.get(key) || {
      date: key, weekday: cursor.getDay(),
      sessionCount: 0, executionCount: 0, credits: 0,
      timeMs: 0, execTimeMs: 0, insideMs: 0, outsideMs: 0,
      firstStart: 0, lastEnd: 0, maxParallel: 0,
      executions: [],
    };
    currentWeek.push(entry);
    if (currentWeek.length === 7) { weeks.push(currentWeek); currentWeek = []; }
    cursor.setDate(cursor.getDate() + 1);
  }
  if (currentWeek.length > 0) weeks.push(currentWeek);
  return weeks;
}

function getHeatColor(timeMs: number): string {
  if (timeMs === 0) return "bg-[var(--bg-tertiary)]";
  const hours = timeMs / 3_600_000;
  if (hours < 0.5) return "bg-emerald-900/60";
  if (hours < 1) return "bg-emerald-700/70";
  if (hours < 2) return "bg-emerald-600/80";
  if (hours < 4) return "bg-emerald-500";
  if (hours < 8) return "bg-emerald-400";
  return "bg-emerald-300";
}

// ---------------------------------------------------------------------------
// Weekly roll-up
// ---------------------------------------------------------------------------
function getISOWeek(dateStr: string): { year: number; week: number; mondayStr: string } {
  const [y, m, d] = dateStr.split("-").map(Number);
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  const dow = (dt.getDay() + 6) % 7;
  const monday = new Date(dt);
  monday.setDate(dt.getDate() - dow);
  const thursday = new Date(monday);
  thursday.setDate(monday.getDate() + 3);
  const week1 = new Date(thursday.getFullYear(), 0, 4);
  const weekNum = 1 + Math.round(((thursday.getTime() - week1.getTime()) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  const ms = String(monday.getMonth() + 1).padStart(2, "0");
  const ds = String(monday.getDate()).padStart(2, "0");
  return { year: thursday.getFullYear(), week: weekNum, mondayStr: `${monday.getFullYear()}-${ms}-${ds}` };
}

interface WeekSummary {
  key: string;
  year: number;
  week: number;
  mondayStr: string;
  timeMs: number;
  insideMs: number;
  outsideMs: number;
  credits: number;
  sessions: number;
  executions: number;
  days: DailyStats[];
  overThreshold: number;
}

function buildWeeklySummaries(daily: DailyStats[]): WeekSummary[] {
  const weekMap = new Map<string, WeekSummary>();
  for (const d of daily) {
    const w = getISOWeek(d.date);
    const key = `${w.year}-W${String(w.week).padStart(2, "0")}`;
    let entry = weekMap.get(key);
    if (!entry) {
      entry = {
        key, year: w.year, week: w.week, mondayStr: w.mondayStr,
        timeMs: 0, insideMs: 0, outsideMs: 0, credits: 0,
        sessions: 0, executions: 0, days: [], overThreshold: 0,
      };
      weekMap.set(key, entry);
    }
    entry.timeMs += d.timeMs;
    entry.insideMs += d.insideMs;
    entry.outsideMs += d.outsideMs;
    entry.credits += d.credits;
    entry.sessions += d.sessionCount;
    entry.executions += d.executionCount;
    entry.days.push(d);
    if (d.timeMs / 3_600_000 > HOURS_THRESHOLD) entry.overThreshold++;
  }
  return Array.from(weekMap.values()).sort((a, b) => a.key.localeCompare(b.key));
}

// ---------------------------------------------------------------------------
// Facet colours
// ---------------------------------------------------------------------------
const FACET_COLORS: Record<string, string> = {
  Spec: "bg-sky-500", spec: "bg-sky-500",
  Vibe: "bg-fuchsia-500", vibe: "bg-fuchsia-500",
  Supervised: "bg-amber-500", supervised: "bg-amber-500",
  Autopilot: "bg-emerald-500", autopilot: "bg-emerald-500",
  full: "bg-emerald-500",
  unknown: "bg-zinc-500", Unknown: "bg-zinc-500",
};

// ---------------------------------------------------------------------------
// Calendar display preferences
// ---------------------------------------------------------------------------
const HOUR_PX_BASE = 44;
const HEADER_PX = 24;
const OFF_HOUR_FACTOR = 0.35;

interface HourRange { start: number; end: number; }
const FULL_HOUR_RANGE: HourRange = { start: 0, end: 24 };
const WORK_HOUR_RANGE: HourRange = { start: 7, end: 23 };

interface CalendarPrefs {
  range: HourRange;
  zoom: number;
  condenseOffHours: boolean;
}

function loadCalendarPrefs(): CalendarPrefs {
  try {
    const raw = localStorage.getItem(CALENDAR_PREF_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && p.range && typeof p.range.start === "number" && typeof p.range.end === "number" && typeof p.zoom === "number") {
        return {
          range: p.range,
          zoom: p.zoom,
          condenseOffHours: p.condenseOffHours !== false,
        };
      }
    }
  } catch {}
  return { range: FULL_HOUR_RANGE, zoom: 1.0, condenseOffHours: true };
}

function saveCalendarPrefs(p: CalendarPrefs) {
  try { localStorage.setItem(CALENDAR_PREF_KEY, JSON.stringify(p)); } catch {}
}

interface HourLayout {
  headerPx: number;
  totalHeightPx: number;
  rows: { hour: number; topPx: number; heightPx: number; isWorkHour: boolean }[];
  minuteToY(minuteOfDay: number): number;
}

function buildHourLayout(
  hourRange: HourRange,
  hourPx: number,
  condense: boolean,
  workStart: number,
  workEnd: number,
): HourLayout {
  const rows: { hour: number; topPx: number; heightPx: number; isWorkHour: boolean }[] = [];
  let cursor = HEADER_PX;
  for (let h = hourRange.start; h < hourRange.end; h++) {
    const inWork = h >= workStart && h < workEnd;
    const height = condense && !inWork ? hourPx * OFF_HOUR_FACTOR : hourPx;
    rows.push({ hour: h, topPx: cursor, heightPx: height, isWorkHour: inWork });
    cursor += height;
  }
  return {
    headerPx: HEADER_PX,
    totalHeightPx: cursor,
    rows,
    minuteToY(minute: number): number {
      const hour = Math.floor(minute / 60);
      const row = rows.find((r) => r.hour === hour);
      if (!row) {
        if (hour < hourRange.start) return HEADER_PX;
        return cursor;
      }
      const fractionOfHour = (minute - hour * 60) / 60;
      return row.topPx + row.heightPx * fractionOfHour;
    },
  };
}

// ===========================================================================
// Root component
// ===========================================================================
type Tab = "overview" | "calendar" | "schedule";

export function Dashboard() {
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>("overview");
  const [schedule, setSchedule] = useState<WorkSchedule>(loadSchedule);
  const [now, setNow] = useState<number>(Date.now());

  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch(`${API}/dashboard`)
        .then((r) => r.json())
        .then((d) => { if (!cancelled) { setData(d); setLoading(false); } })
        .catch(() => { if (!cancelled) setLoading(false); });
    };
    load();
    const t = setInterval(load, 5000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(t);
  }, []);

  useEffect(() => { saveSchedule(schedule); }, [schedule]);

  const dailyMap = useMemo(() => {
    if (!data) return new Map<string, DailyStats>();
    return computeDailyStats(data.executions || [], data.sessions || [], schedule);
  }, [data, schedule]);

  if (loading) return <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Loading dashboard...</div>;
  if (!data) return <div className="flex items-center justify-center h-full text-[var(--text-secondary)]">Failed to load dashboard</div>;

  const tz = schedule.timezone;
  const todayKey = tzTodayKey(tz);
  const zoneAbbrev = (() => {
    try {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "short" }).formatToParts(now);
      return parts.find(p => p.type === "timeZoneName")?.value || tz;
    } catch { return tz; }
  })();
  const todayWeekday = (() => {
    try { return new Intl.DateTimeFormat(schedule.locale, { timeZone: tz, weekday: "long" }).format(now); }
    catch { return DAY_FULL[tzParts(tz, now).weekday]; }
  })();
  const nowInTz = formatTimeInTz(now, tz, schedule.locale);

  return (
    <div className="max-w-6xl mx-auto p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h2 className="text-lg font-medium tracking-tight">Kiro Usage Dashboard</h2>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            {todayWeekday}, {todayKey} · {tz} ({zoneAbbrev})
          </p>
        </div>
        <div className="text-right">
          <div className="text-2xl font-light tabular-nums text-[var(--text-primary)]">{nowInTz}</div>
          <div className="text-xs text-[var(--text-secondary)]">{tz.split("/").pop()?.replace(/_/g, " ")}</div>
          {data.scanning && <span className="text-xs text-[var(--accent)] animate-pulse">Scanning…</span>}
        </div>
      </div>

      <div className="flex gap-1 p-1 rounded-lg bg-[var(--bg-secondary)] border border-[var(--border)] w-fit">
        <TabButton active={tab === "overview"} onClick={() => setTab("overview")} icon={<LayoutGrid size={13} />}>Overview</TabButton>
        <TabButton active={tab === "calendar"} onClick={() => setTab("calendar")} icon={<CalendarDays size={13} />}>Calendar</TabButton>
        <TabButton active={tab === "schedule"} onClick={() => setTab("schedule")} icon={<Settings2 size={13} />}>Schedule</TabButton>
      </div>

      {tab === "overview" && <OverviewTab data={data} schedule={schedule} dailyMap={dailyMap} />}
      {tab === "calendar" && <CalendarTab data={data} schedule={schedule} dailyMap={dailyMap} />}
      {tab === "schedule" && <ScheduleTab schedule={schedule} setSchedule={setSchedule} dailyMap={dailyMap} />}
    </div>
  );
}

function TabButton({ active, onClick, icon, children }: { active: boolean; onClick: () => void; icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        "flex items-center gap-1.5 px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
        active ? "bg-[var(--accent)]/15 text-[var(--accent)] ring-1 ring-[var(--accent)]/40" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
      )}
    >
      {icon}
      {children}
    </button>
  );
}

// ===========================================================================
// Overview tab
// ===========================================================================
function OverviewTab({ data, schedule, dailyMap }: { data: DashboardData; schedule: WorkSchedule; dailyMap: Map<string, DailyStats> }) {
  const [expandedWeeks, setExpandedWeeks] = useState<Set<string>>(new Set());
  const [calendarMonths, setCalendarMonths] = useState(8);

  const toggleWeek = (key: string) => {
    setExpandedWeeks((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const tz = schedule.timezone;
  const allDaily = Array.from(dailyMap.values());
  const calendarWeeks = buildCalendar(dailyMap, calendarMonths, tz);
  const weeklySummaries = buildWeeklySummaries(allDaily);
  const todayKey = tzTodayKey(tz);
  const todayData = dailyMap.get(todayKey);

  const daysOverThreshold = allDaily.filter(d => d.timeMs / 3_600_000 > HOURS_THRESHOLD).length;
  const totalDaysWorked = allDaily.filter(d => d.timeMs > 0).length;
  const totalInsideMs = allDaily.reduce((sum, d) => sum + d.insideMs, 0);
  const totalOutsideMs = allDaily.reduce((sum, d) => sum + d.outsideMs, 0);

  const facets = data.facets;

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <TimeCard
          title="Wall-clock time"
          subtitle="Actual time at the keyboard (overlapping sessions merged)"
          value={formatDuration(data.totalTimeMs)}
          icon={<Clock size={16} />}
          accent="accent"
        />
        <TimeCard
          title="Session time"
          subtitle="Sum of every execution duration (parallel sessions counted separately)"
          value={formatDuration(data.totalExecTimeMs)}
          icon={<Layers size={16} />}
          accent="neutral"
        />
      </div>

      {data.longExecutions && data.longExecutions.length > 0 && (
        <LongExecutionsPanel list={data.longExecutions} tz={tz} locale={schedule.locale} />
      )}

      <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
        <StatCard icon={<Coins size={14} />} label="Credits" value={data.totalCredits.toFixed(0)} />
        <StatCard icon={<Clock size={14} />} label="Today" value={formatDuration(todayData?.timeMs || 0)} />
        <StatCard icon={<Layers size={14} />} label="Sessions" value={String(data.totalSessions)} />
        <StatCard icon={<Activity size={14} />} label="Executions" value={String(data.totalExecutions)} />
        <StatCard icon={<TrendingUp size={14} />} label="Days worked" value={String(totalDaysWorked)} />
        <StatCard icon={<AlertTriangle size={14} />} label={`Days >${HOURS_THRESHOLD}h`} value={String(daysOverThreshold)} highlight />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ScheduleCard icon={<Calendar size={14} />} label="Inside work schedule" value={formatDuration(totalInsideMs)} accent="inside" />
        <ScheduleCard icon={<Moon size={14} />} label="Outside work schedule" value={formatDuration(totalOutsideMs)} accent="outside" />
      </div>

      {facets && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-3">
          <FacetPanel title="Session type" data={facets.sessionType} total={data.totalSessions} />
          <FacetPanel title="Autonomy mode" data={facets.autonomyMode} total={data.totalSessions} />
          <FacetPanel title="Model usage" data={facets.model} total={data.totalSessions} compact />
        </div>
      )}

      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium text-[var(--text-secondary)] flex items-center gap-2">
            <Calendar size={14} /> Activity heat map
          </h3>
          <div className="flex items-center gap-3">
            <div className="flex gap-1">
              {[3, 6, 8, 12].map((m) => (
                <button key={m} onClick={() => setCalendarMonths(m)} className={clsx("px-2 py-0.5 text-xs rounded", calendarMonths === m ? "bg-[var(--accent)] text-white" : "text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)]")}>
                  {m}mo
                </button>
              ))}
            </div>
            <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
              <span>Less</span>
              <div className="w-3 h-3 rounded-sm bg-[var(--bg-tertiary)]" />
              <div className="w-3 h-3 rounded-sm bg-emerald-900/60" />
              <div className="w-3 h-3 rounded-sm bg-emerald-700/70" />
              <div className="w-3 h-3 rounded-sm bg-emerald-500" />
              <div className="w-3 h-3 rounded-sm bg-emerald-300" />
              <span>More</span>
            </div>
          </div>
        </div>
        <div className="flex gap-[3px] overflow-x-auto pb-2">
          <div className="flex flex-col gap-[3px] mr-1 text-[10px] text-[var(--text-secondary)] shrink-0" style={{ width: "20px" }}>
            <div className="h-[13px]" />
            <div className="h-[13px] flex items-center">Mon</div>
            <div className="h-[13px]" />
            <div className="h-[13px] flex items-center">Wed</div>
            <div className="h-[13px]" />
            <div className="h-[13px] flex items-center">Fri</div>
            <div className="h-[13px]" />
          </div>
          <div className="flex gap-[3px]">
            {calendarWeeks.map((week, wi) => (
              <div key={wi} className="flex flex-col gap-[3px]">
                {week.map((day) => {
                  const overThreshold = day.timeMs / 3_600_000 > HOURS_THRESHOLD;
                  return (
                    <div key={day.date} className={clsx("w-[13px] h-[13px] rounded-sm group relative", overThreshold ? "ring-1 ring-amber-400" : "", getHeatColor(day.timeMs))}>
                      <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1 text-xs whitespace-nowrap z-20 shadow-lg">
                        <div className="font-medium">{day.date}</div>
                        <div>{formatDuration(day.timeMs)} · {day.credits.toFixed(1)} cr</div>
                        {day.firstStart > 0 && (
                          <div>Start: {formatTimeInTz(day.firstStart, tz, schedule.locale)} → End: {formatTimeInTz(day.lastEnd, tz, schedule.locale)}</div>
                        )}
                        {overThreshold && <div className="text-amber-400 font-medium">Over {HOURS_THRESHOLD}h threshold</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
          </div>
        </div>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h3 className="text-sm font-medium mb-3 text-[var(--text-secondary)]">Weekly breakdown</h3>
        <div className="space-y-0.5 max-h-[520px] overflow-y-auto">
          {weeklySummaries.slice().reverse().map((w) => {
            const expanded = expandedWeeks.has(w.key);
            const weekHours = w.timeMs / 3_600_000;
            const maxWeekHours = Math.max(...weeklySummaries.map(x => x.timeMs / 3_600_000), 1);
            return (
              <div key={w.key}>
                <button onClick={() => toggleWeek(w.key)} className="w-full flex items-center gap-2 px-2 py-1.5 rounded hover:bg-[var(--bg-tertiary)] transition-colors">
                  {expanded ? <ChevronDown size={12} className="text-[var(--text-secondary)] shrink-0" /> : <ChevronRight size={12} className="text-[var(--text-secondary)] shrink-0" />}
                  <span className="text-xs font-mono w-20 text-[var(--text-secondary)]">{w.key}</span>
                  <span className="text-[10px] text-[var(--text-secondary)] w-24 shrink-0">wk of {w.mondayStr}</span>
                  <div className="flex-1 h-4 bg-[var(--bg-tertiary)] rounded overflow-hidden">
                    <div className={clsx("h-full rounded", weekHours > HOURS_THRESHOLD * 5 ? "bg-amber-500" : "bg-[var(--accent)] opacity-70")} style={{ width: `${Math.min((weekHours / maxWeekHours) * 100, 100)}%` }} />
                  </div>
                  <span className="text-xs font-medium w-16 text-right text-[var(--text-primary)]">{formatHours(w.timeMs)}</span>
                  <span className="text-xs w-16 text-right text-[var(--text-secondary)]">{w.credits.toFixed(0)} cr</span>
                  <span className="text-xs w-12 text-right text-[var(--text-secondary)]">{w.sessions} s</span>
                  {w.overThreshold > 0 && <span className="text-xs text-amber-400 w-6 text-right">⚠</span>}
                </button>
                {expanded && (
                  <div className="ml-6 mt-1 mb-2 border-l border-[var(--border)] pl-3">
                    <WeekDaysTable days={w.days} tz={tz} locale={schedule.locale} />
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h3 className="text-sm font-medium mb-3 text-[var(--text-secondary)]">Top workspaces</h3>
        <div className="space-y-2">
          {data.workspaces.slice(0, 12).map((ws) => (
            <div key={ws.name} className="flex items-center gap-3 text-sm">
              <FolderOpen size={14} className="text-[var(--text-secondary)] shrink-0" />
              <span className="flex-1 truncate text-[var(--text-primary)]">{ws.name}</span>
              <span className="text-xs text-[var(--text-secondary)]">{ws.sessions} sess</span>
              <span className="text-xs text-[var(--text-secondary)] w-16 text-right">{ws.credits.toFixed(0)} cr</span>
              <span className="text-sm font-medium w-16 text-right">{formatHours(ws.timeMs)}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function WeekDaysTable({ days, tz, locale }: { days: DailyStats[]; tz: string; locale: string }) {
  const [openDay, setOpenDay] = useState<string | null>(null);
  return (
    <table className="w-full text-xs">
      <thead>
        <tr className="text-[var(--text-secondary)]">
          <th className="text-left py-1 pr-2 w-4" />
          <th className="text-left py-1 pr-2">Date</th>
          <th className="text-left py-1 pr-2">Start</th>
          <th className="text-left py-1 pr-2">Finish</th>
          <th className="text-right py-1 pr-2">Wall clock</th>
          <th className="text-right py-1 pr-2">Parallel</th>
          <th className="text-right py-1 pr-2">Credits</th>
          <th className="text-right py-1">Sessions</th>
        </tr>
      </thead>
      <tbody>
        {days.sort((a, b) => a.date.localeCompare(b.date)).map((d) => {
          const dayHours = d.timeMs / 3_600_000;
          const over = dayHours > HOURS_THRESHOLD;
          const hasRecords = d.executions.length > 0;
          const isOpen = openDay === d.date;
          return (
            <Fragment key={d.date}>
              <tr className={clsx(over && "text-amber-400")}>
                <td className="py-1 pr-2">
                  {hasRecords ? (
                    <button onClick={() => setOpenDay(isOpen ? null : d.date)} className="text-[var(--text-secondary)] hover:text-[var(--text-primary)]">
                      {isOpen ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
                    </button>
                  ) : null}
                </td>
                <td className="py-1 pr-2 font-medium">{d.date}</td>
                <td className="py-1 pr-2">{d.firstStart > 0 ? formatTimeInTz(d.firstStart, tz, locale) : "—"}</td>
                <td className="py-1 pr-2">{d.lastEnd > 0 ? formatTimeInTz(d.lastEnd, tz, locale) : "—"}</td>
                <td className="py-1 pr-2 text-right font-medium">{d.timeMs > 0 ? formatHours(d.timeMs) : "—"}{over ? " ⚠" : ""}</td>
                <td className="py-1 pr-2 text-right">{d.maxParallel > 1 ? `${d.maxParallel}×` : "1×"}</td>
                <td className="py-1 pr-2 text-right">{d.credits > 0 ? d.credits.toFixed(1) : "—"}</td>
                <td className="py-1 text-right">{d.sessionCount || "—"}</td>
              </tr>
              {isOpen && hasRecords && (
                <tr>
                  <td></td>
                  <td colSpan={7} className="pb-2">
                    <DayExecutionsTable executions={d.executions} tz={tz} locale={locale} />
                  </td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

function DayExecutionsTable({ executions, tz, locale }: { executions: ExecutionRow[]; tz: string; locale: string }) {
  const bySession = useMemo(() => {
    const m = new Map<string, ExecutionRow[]>();
    for (const r of executions) {
      const k = r.sessionId || `exec-${r.executionId}`;
      if (!m.has(k)) m.set(k, []);
      m.get(k)!.push(r);
    }
    return Array.from(m.entries()).map(([sid, arr]) => ({
      sessionId: sid,
      records: arr.sort((a, b) => a.start - b.start),
      title: arr[0].sessionTitle || sid.slice(0, 8),
      sessionType: arr[0].sessionType,
      autonomyMode: arr[0].autonomyMode,
      workspace: arr[0].workspace,
      totalMs: arr.reduce((s, r) => s + (r.end - r.start), 0),
    })).sort((a, b) => a.records[0].start - b.records[0].start);
  }, [executions]);

  return (
    <div className="ml-4 border-l border-[var(--border)] pl-3 space-y-1">
      {bySession.map((s) => (
        <div key={s.sessionId} className="text-xs flex items-center gap-2">
          <FacetDot name={s.sessionType} />
          <FacetDot name={s.autonomyMode} />
          <span className="truncate flex-1 text-[var(--text-primary)]">{s.title || "Untitled"}</span>
          <span className="text-[var(--text-secondary)] truncate max-w-[160px]">{s.workspace}</span>
          <span className="text-[var(--text-secondary)]">{formatTimeInTz(s.records[0].start, tz, locale)} → {formatTimeInTz(s.records[s.records.length - 1].end, tz, locale)}</span>
          <span className="text-[var(--text-primary)] font-medium w-16 text-right">{formatHours(s.totalMs)}</span>
          <span className="text-[var(--text-secondary)] w-10 text-right">{s.records.length} ex</span>
        </div>
      ))}
    </div>
  );
}

// ===========================================================================
// Calendar tab
// ===========================================================================
function CalendarTab({ data, schedule, dailyMap }: { data: DashboardData; schedule: WorkSchedule; dailyMap: Map<string, DailyStats> }) {
  const [weekOffset, setWeekOffset] = useState(0);
  const [mode, setMode] = useState<"week" | "day">("week");
  const [prefs, setPrefs] = useState<CalendarPrefs>(loadCalendarPrefs);
  useEffect(() => { saveCalendarPrefs(prefs); }, [prefs]);

  const tz = schedule.timezone;

  const weekDays = useMemo(() => {
    const todayKey = tzTodayKey(tz);
    const [y, m, d] = todayKey.split("-").map(Number);
    const today = new Date(y, m - 1, d);
    const anchor = new Date(today);
    anchor.setDate(today.getDate() - today.getDay() + weekOffset * 7);
    return Array.from({ length: 7 }, (_, i) => {
      const dd = new Date(anchor);
      dd.setDate(anchor.getDate() + i);
      const ys = dd.getFullYear();
      const ms = String(dd.getMonth() + 1).padStart(2, "0");
      const ds = String(dd.getDate()).padStart(2, "0");
      return `${ys}-${ms}-${ds}`;
    });
  }, [weekOffset, tz]);

  const weekDaysSet = useMemo(() => new Set(weekDays), [weekDays]);
  const recordsByDay = useMemo(() => {
    const map = new Map<string, ExecutionRow[]>();
    for (const key of weekDays) map.set(key, []);
    for (const e of (data.executions || [])) {
      const segs = splitByTzDay(e.start, e.end, tz);
      for (const seg of segs) {
        if (weekDaysSet.has(seg.day)) {
          map.get(seg.day)!.push(e);
        }
      }
    }
    return map;
  }, [data.executions, weekDays, weekDaysSet, tz]);

  const effectiveRange = useMemo<HourRange>(() => {
    let minHour = prefs.range.start;
    let maxHour = prefs.range.end;
    let widen = false;
    for (const key of weekDays) {
      const recs = recordsByDay.get(key) || [];
      for (const r of recs) {
        const startDay = tzDateKey(tz, r.start);
        const endDay = tzDateKey(tz, r.end);
        if (startDay === key) {
          const sh = tzParts(tz, r.start).hour;
          if (sh < minHour) { minHour = sh; widen = true; }
        }
        if (endDay === key) {
          const endParts = tzParts(tz, r.end);
          const eh = endParts.hour + (endParts.minute > 0 ? 1 : 0);
          if (eh > maxHour) { maxHour = eh; widen = true; }
        }
      }
    }
    if (!widen) return prefs.range;
    return { start: Math.max(0, minHour), end: Math.min(24, maxHour) };
  }, [weekDays, recordsByDay, prefs.range, tz]);

  const weekStats = useMemo(() => {
    // Active (clamped) totals come from dailyMap. Raw totals we compute
    // directly from the raw exec rows so we can expose the un-clamped
    // picture side by side. Neither is hidden from the user.
    let totalSession = 0;
    let insideMs = 0;
    let outsideMs = 0;
    let wall = 0;
    for (const key of weekDays) {
      const ds = dailyMap.get(key);
      if (!ds) continue;
      totalSession += ds.execTimeMs;
      insideMs += ds.insideMs;
      outsideMs += ds.outsideMs;
      wall += ds.timeMs;
    }

    const weekStartKey = weekDays[0];
    const weekEndKey = weekDays[weekDays.length - 1];
    if (!weekStartKey || !weekEndKey) {
      return { totalSession, wall, insideMs, outsideMs, totalSessionRaw: 0, wallRaw: 0, peakParallelActive: 0, peakParallelRaw: 0, clockIn: null as number | null, clockOut: null as number | null };
    }
    const [ys, ms, ds] = weekStartKey.split("-").map(Number);
    const guessMs = Date.UTC(ys, ms - 1, ds);
    const offsetMin = tzOffsetMinutes(tz, guessMs);
    const weekStartMs = guessMs - offsetMin * 60_000;
    const weekEndMs = weekStartMs + 7 * 86_400_000;

    const activeIntervals: [number, number][] = [];
    const rawIntervals: [number, number][] = [];
    let clockIn: number | null = null;
    let clockOut: number | null = null;
    let totalSessionRaw = 0;
    for (const e of data.executions || []) {
      const rawEnd = e.endRaw ?? e.end;
      const touchesActive = e.start < weekEndMs && e.end > weekStartMs;
      const touchesRaw = e.start < weekEndMs && rawEnd > weekStartMs;
      if (!touchesActive && !touchesRaw) continue;
      if (touchesActive) {
        const s = Math.max(e.start, weekStartMs);
        const f = Math.min(e.end, weekEndMs);
        if (f > s) {
          activeIntervals.push([s, f]);
          if (clockIn === null || s < clockIn) clockIn = s;
          if (clockOut === null || f > clockOut) clockOut = f;
        }
      }
      if (touchesRaw) {
        const s = Math.max(e.start, weekStartMs);
        const f = Math.min(rawEnd, weekEndMs);
        if (f > s) {
          rawIntervals.push([s, f]);
          totalSessionRaw += (f - s);
        }
      }
    }

    let wallRaw = 0;
    if (rawIntervals.length) {
      const sorted = rawIntervals.slice().sort((a, b) => a[0] - b[0]);
      let curS = sorted[0][0], curE = sorted[0][1];
      for (let i = 1; i < sorted.length; i++) {
        const [a, b] = sorted[i];
        if (a <= curE) { if (b > curE) curE = b; }
        else { wallRaw += curE - curS; curS = a; curE = b; }
      }
      wallRaw += curE - curS;
    }

    function peak(intervals: [number, number][]): number {
      if (!intervals.length) return 0;
      const events: [number, number][] = [];
      for (const [a, b] of intervals) { events.push([a, 1]); events.push([b, -1]); }
      events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let p = 0, cur = 0;
      for (const [, d] of events) { cur += d; if (cur > p) p = cur; }
      return p;
    }

    return {
      totalSession, wall, insideMs, outsideMs,
      totalSessionRaw, wallRaw,
      peakParallelActive: peak(activeIntervals),
      peakParallelRaw: peak(rawIntervals),
      clockIn, clockOut,
    };
  }, [weekDays, dailyMap, data.executions, tz]);

  const layout = useMemo(
    () => buildHourLayout(effectiveRange, HOUR_PX_BASE * prefs.zoom, prefs.condenseOffHours, schedule.startHour, schedule.endHour),
    [effectiveRange, prefs.zoom, prefs.condenseOffHours, schedule.startHour, schedule.endHour],
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-2">
          <button onClick={() => setWeekOffset(w => w - 1)} className="px-2 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)]">←</button>
          <div className="text-sm text-[var(--text-primary)] font-medium min-w-[180px] text-center">
            Week of {weekDays[0]} · {tz}
          </div>
          <button onClick={() => setWeekOffset(w => w + 1)} disabled={weekOffset >= 0} className="px-2 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-sm hover:bg-[var(--bg-tertiary)] disabled:opacity-40">→</button>
          <button onClick={() => setWeekOffset(0)} className="ml-1 px-2 py-1 rounded bg-[var(--bg-secondary)] border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]">This week</button>
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => setPrefs(p => ({ ...p, condenseOffHours: !p.condenseOffHours }))}
            className={clsx(
              "px-2 py-1 rounded-md text-xs border flex items-center gap-1.5",
              prefs.condenseOffHours
                ? "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40"
                : "bg-[var(--bg-secondary)] text-[var(--text-secondary)] border-[var(--border)] hover:text-[var(--text-primary)]"
            )}
            title="Compress hours outside your work window (like Outlook)"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: prefs.condenseOffHours ? "currentColor" : "transparent", border: "1px solid currentColor" }} />
            Condense off-hours
          </button>
          <div className="flex gap-1 p-1 rounded-md bg-[var(--bg-secondary)] border border-[var(--border)]">
            <button
              onClick={() => setPrefs(p => ({ ...p, range: FULL_HOUR_RANGE }))}
              className={clsx("px-2 py-1 rounded text-xs", prefs.range.start === 0 && prefs.range.end === 24 ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)]")}
            >
              24 hr
            </button>
            <button
              onClick={() => setPrefs(p => ({ ...p, range: WORK_HOUR_RANGE }))}
              className={clsx("px-2 py-1 rounded text-xs", prefs.range.start === WORK_HOUR_RANGE.start && prefs.range.end === WORK_HOUR_RANGE.end ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)]")}
            >
              7a – 11p
            </button>
          </div>
          <div className="flex items-center gap-1 text-xs text-[var(--text-secondary)]">
            <span>Zoom</span>
            <button onClick={() => setPrefs(p => ({ ...p, zoom: Math.max(0.6, +(p.zoom - 0.2).toFixed(2)) }))} className="w-6 h-6 rounded bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)]" aria-label="Zoom out">−</button>
            <span className="tabular-nums w-8 text-center text-[var(--text-primary)]">{prefs.zoom.toFixed(1)}×</span>
            <button onClick={() => setPrefs(p => ({ ...p, zoom: Math.min(2.0, +(p.zoom + 0.2).toFixed(2)) }))} className="w-6 h-6 rounded bg-[var(--bg-secondary)] border border-[var(--border)] hover:bg-[var(--bg-tertiary)]" aria-label="Zoom in">+</button>
          </div>
          <div className="flex gap-1 p-1 rounded-md bg-[var(--bg-secondary)] border border-[var(--border)]">
            <button onClick={() => setMode("week")} className={clsx("px-2 py-1 rounded text-xs flex items-center gap-1", mode === "week" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)]")}><CalendarRange size={12} /> Week</button>
            <button onClick={() => setMode("day")} className={clsx("px-2 py-1 rounded text-xs flex items-center gap-1", mode === "day" ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)]")}><CalendarDays size={12} /> Day</button>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Clock size={14} />} label="Wall clock (active)" value={formatDuration(weekStats.wall)} />
        <StatCard icon={<Layers size={14} />} label="Session time (active)" value={formatDuration(weekStats.totalSession)} />
        <StatCard icon={<Calendar size={14} />} label="Inside schedule" value={formatDuration(weekStats.insideMs)} />
        <StatCard icon={<Moon size={14} />} label="Outside schedule" value={formatDuration(weekStats.outsideMs)} />
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
        <StatCard icon={<Clock size={14} />} label="Wall clock (raw)" value={formatDuration(weekStats.wallRaw)} />
        <StatCard icon={<Layers size={14} />} label="Session time (raw)" value={formatDuration(weekStats.totalSessionRaw)} />
        <StatCard icon={<Activity size={14} />} label="Peak parallel (active)" value={String(weekStats.peakParallelActive)} />
        <StatCard icon={<Activity size={14} />} label="Peak parallel (raw)" value={String(weekStats.peakParallelRaw)} />
      </div>
      <div className="text-[11px] text-[var(--text-secondary)]">
        <b>active</b> = aborted sessions clipped to last action + 60s.
        <b> raw</b> = Kiro's original endTime (no clamping).
        <b> Peak parallel</b> = max executions open at the same moment this week.
      </div>

      <WeekAudit
        weekDays={weekDays}
        executions={data.executions || []}
        tz={tz}
        locale={schedule.locale}
      />

      <WeekConcurrencyStrip
        weekDays={weekDays}
        executions={data.executions || []}
        tz={tz}
      />

      <div className="flex items-center gap-4 text-xs text-[var(--text-secondary)] flex-wrap">
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-emerald-600/80" /> Autopilot</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-amber-600/80" /> Supervised</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-indigo-600/80" /> Unknown</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[var(--accent)]/15 border border-[var(--accent)]/30" /> Work-schedule band</span>
        <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-[var(--bg-tertiary)]/80" /> Off-hours (condensed)</span>
      </div>

      {mode === "week" ? (
        <WeekGrid weekDays={weekDays} recordsByDay={recordsByDay} schedule={schedule} layout={layout} />
      ) : (
        <DayGrid weekDays={weekDays} recordsByDay={recordsByDay} schedule={schedule} layout={layout} />
      )}
    </div>
  );
}

function HourGutter({ layout }: { layout: HourLayout }) {
  return (
    <div className="flex flex-col text-[10px] text-[var(--text-secondary)] select-none" style={{ width: 48 }}>
      <div style={{ height: layout.headerPx }} />
      {layout.rows.map((row) => (
        <div
          key={row.hour}
          className={clsx(
            "border-t border-[var(--border)] pr-1 text-right overflow-hidden flex items-start justify-end",
            !row.isWorkHour && "text-[var(--text-secondary)]/60",
          )}
          style={{ height: row.heightPx }}
        >
          {(row.hour % 12) || 12}{row.hour < 12 ? "a" : "p"}
        </div>
      ))}
    </div>
  );
}

function ScheduleBand({ schedule, dayWeekday, layout }: { schedule: WorkSchedule; dayWeekday: number; layout: HourLayout }) {
  if (!schedule.workDays[dayWeekday]) return null;
  const bandStart = schedule.startHour;
  const bandEnd = schedule.endHour;
  if (bandEnd <= bandStart) return null;
  const top = layout.minuteToY(bandStart * 60);
  const bottom = layout.minuteToY(bandEnd * 60);
  const height = bottom - top;
  if (height <= 0) return null;
  return (
    <div
      className="absolute left-0 right-0 bg-[var(--accent)]/5 border-y border-[var(--accent)]/20 pointer-events-none"
      style={{ top, height }}
    />
  );
}

function OffHourStripes({ layout }: { layout: HourLayout }) {
  return (
    <>
      {layout.rows.filter((r) => !r.isWorkHour).map((row) => (
        <div
          key={row.hour}
          className="absolute left-0 right-0 bg-[var(--bg-tertiary)]/40 pointer-events-none"
          style={{ top: row.topPx, height: row.heightPx }}
        />
      ))}
    </>
  );
}

function WeekGrid({ weekDays, recordsByDay, schedule, layout }: {
  weekDays: string[];
  recordsByDay: Map<string, ExecutionRow[]>;
  schedule: WorkSchedule;
  layout: HourLayout;
}) {
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-x-auto">
      <div className="flex min-w-[1000px]">
        <HourGutter layout={layout} />
        {weekDays.map((dateKey) => {
          const [y, m, d] = dateKey.split("-").map(Number);
          const dd = new Date(y, m - 1, d);
          const weekday = dd.getDay();
          const records = recordsByDay.get(dateKey) || [];
          return (
            <DayColumn
              key={dateKey}
              dateKey={dateKey}
              weekday={weekday}
              label={`${DAY_LABELS[weekday]} ${d}`}
              records={records}
              schedule={schedule}
              layout={layout}
              compact
            />
          );
        })}
      </div>
    </div>
  );
}

function DayGrid({ weekDays, recordsByDay, schedule, layout }: {
  weekDays: string[];
  recordsByDay: Map<string, ExecutionRow[]>;
  schedule: WorkSchedule;
  layout: HourLayout;
}) {
  const tz = schedule.timezone;
  const [selected, setSelected] = useState(() => {
    const today = tzTodayKey(tz);
    return weekDays.includes(today) ? today : weekDays[weekDays.length - 1];
  });
  useEffect(() => {
    if (!weekDays.includes(selected)) setSelected(weekDays[weekDays.length - 1]);
  }, [weekDays, selected]);
  const records = recordsByDay.get(selected) || [];
  const [y, m, d] = selected.split("-").map(Number);
  const dd = new Date(y, m - 1, d);
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg">
      <div className="flex border-b border-[var(--border)] px-2 py-2 gap-1 overflow-x-auto">
        {weekDays.map((dk) => {
          const [yy, mm, ddd] = dk.split("-").map(Number);
          const date = new Date(yy, mm - 1, ddd);
          const weekday = date.getDay();
          return (
            <button
              key={dk}
              onClick={() => setSelected(dk)}
              className={clsx(
                "px-3 py-1 rounded text-xs flex items-center gap-1.5 whitespace-nowrap",
                selected === dk ? "bg-[var(--accent)]/15 text-[var(--accent)]" : "text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
              )}
            >
              <span>{DAY_LABELS[weekday]}</span>
              <span className="tabular-nums">{ddd}</span>
            </button>
          );
        })}
      </div>
      <div className="flex">
        <HourGutter layout={layout} />
        <DayColumn
          dateKey={selected}
          weekday={dd.getDay()}
          label={DAY_FULL[dd.getDay()]}
          records={records}
          schedule={schedule}
          layout={layout}
          compact={false}
        />
      </div>
    </div>
  );
}

interface PositionedBlock {
  record: ExecutionRow;
  topPx: number;
  heightPx: number;
  columnIndex: number;
  columnCount: number;
}

function layoutDay(records: ExecutionRow[], dateKey: string, tz: string, hourRange: HourRange, layout: HourLayout): PositionedBlock[] {
  if (records.length === 0) return [];
  const [dayStartMs, dayEndMs] = tzDayBoundariesUtc(tz, dateKey);
  const rangeStartMs = dayStartMs + hourRange.start * 3_600_000;
  const rangeEndMs = dayStartMs + hourRange.end * 3_600_000;

  const clipped = records
    .map((r) => ({
      record: r,
      startMs: Math.max(r.start, Math.max(dayStartMs, rangeStartMs)),
      endMs: Math.min(r.end, Math.min(dayEndMs, rangeEndMs)),
    }))
    .filter((c) => c.endMs > c.startMs)
    .sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);

  const columns: { endMs: number }[] = [];
  const assignments: number[] = [];
  for (const c of clipped) {
    let placed = -1;
    for (let i = 0; i < columns.length; i++) {
      if (columns[i].endMs <= c.startMs) { placed = i; break; }
    }
    if (placed === -1) { placed = columns.length; columns.push({ endMs: c.endMs }); }
    else columns[placed].endMs = c.endMs;
    assignments.push(placed);
  }

  const clusterCount: number[] = new Array(clipped.length).fill(0);
  let i = 0;
  while (i < clipped.length) {
    let j = i;
    let clusterEnd = clipped[i].endMs;
    while (j + 1 < clipped.length && clipped[j + 1].startMs < clusterEnd) {
      j++;
      if (clipped[j].endMs > clusterEnd) clusterEnd = clipped[j].endMs;
    }
    const uniqueCols = new Set(assignments.slice(i, j + 1)).size;
    for (let k = i; k <= j; k++) clusterCount[k] = uniqueCols;
    i = j + 1;
  }

  return clipped.map((c, idx) => {
    const startMinInDay = (c.startMs - dayStartMs) / 60_000;
    const endMinInDay = (c.endMs - dayStartMs) / 60_000;
    const topPx = layout.minuteToY(startMinInDay);
    const bottomPx = layout.minuteToY(endMinInDay);
    return {
      record: c.record,
      topPx,
      heightPx: Math.max(3, bottomPx - topPx),
      columnIndex: assignments[idx],
      columnCount: Math.max(1, clusterCount[idx]),
    };
  });
}

function DayColumn({ dateKey, weekday, label, records, schedule, layout, compact }: {
  dateKey: string;
  weekday: number;
  label: string;
  records: ExecutionRow[];
  schedule: WorkSchedule;
  layout: HourLayout;
  compact: boolean;
}) {
  const hourRange = { start: layout.rows[0]?.hour ?? 0, end: (layout.rows[layout.rows.length - 1]?.hour ?? 23) + 1 };
  const blocks = useMemo(() => layoutDay(records, dateKey, schedule.timezone, hourRange, layout),
    [records, dateKey, schedule.timezone, layout, hourRange.start, hourRange.end]);
  const isWorkDay = schedule.workDays[weekday];
  const [hoveredSession, setHoveredSession] = useState<string | null>(null);

  return (
    <div className="flex-1 min-w-0 border-l border-[var(--border)] relative" style={{ height: layout.totalHeightPx }}>
      <div className={clsx(
        "absolute top-0 left-0 right-0 px-2 text-[11px] flex items-center justify-between border-b border-[var(--border)] bg-[var(--bg-secondary)] z-10",
        !isWorkDay && "opacity-70"
      )} style={{ height: layout.headerPx }}>
        <span className="font-medium">{label}</span>
        {!isWorkDay && <span className="text-[var(--text-secondary)] text-[9px] uppercase">off</span>}
      </div>
      {isWorkDay && <OffHourStripes layout={layout} />}
      <ScheduleBand schedule={schedule} dayWeekday={weekday} layout={layout} />
      {layout.rows.map((row) => (
        <div key={row.hour} className="absolute left-0 right-0 border-t border-[var(--border)]" style={{ top: row.topPx }} />
      ))}
      {blocks.map((b, idx) => {
        const widthPct = 100 / b.columnCount;
        const leftPct = widthPct * b.columnIndex;
        const bgClass = autonomyBgClass(b.record.autonomyMode);
        const isHighlighted = hoveredSession === b.record.sessionId;
        const tz = schedule.timezone;
        return (
          <div
            key={idx}
            onMouseEnter={() => setHoveredSession(b.record.sessionId)}
            onMouseLeave={() => setHoveredSession(null)}
            className={clsx(
              "absolute rounded px-1 overflow-hidden cursor-pointer group transition-all",
              bgClass,
              isHighlighted ? "ring-2 ring-white/60 z-10" : "ring-1 ring-black/20"
            )}
            style={{
              top: b.topPx,
              height: b.heightPx,
              left: `calc(${leftPct}% + 2px)`,
              width: `calc(${widthPct}% - 4px)`,
            }}
            title={`${b.record.sessionTitle || b.record.sessionId.slice(0, 8)}\n${formatTimeInTz(b.record.start, tz, schedule.locale)} → ${formatTimeInTz(b.record.end, tz, schedule.locale)}\n${b.record.workspace} · ${b.record.sessionType} · ${b.record.autonomyMode}\nModel: ${b.record.model}`}
          >
            {b.heightPx >= 16 && !compact && (
              <div className="text-[10px] text-white leading-tight pt-0.5">
                <div className="truncate font-medium">{b.record.sessionTitle || "Untitled"}</div>
                <div className="truncate text-white/80">{formatTimeInTz(b.record.start, tz, schedule.locale)}</div>
              </div>
            )}
            {compact && b.heightPx >= 20 && (
              <div className="text-[9px] text-white/90 leading-tight pt-0.5 truncate">
                {formatTimeInTz(b.record.start, tz, schedule.locale)}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function autonomyBgClass(autonomy: string): string {
  const a = (autonomy || "").toLowerCase();
  if (a === "supervised") return "bg-amber-600/80 hover:bg-amber-500";
  if (a === "autopilot" || a === "full") return "bg-emerald-600/80 hover:bg-emerald-500";
  return "bg-indigo-600/80 hover:bg-indigo-500";
}

// ===========================================================================
// Schedule tab
// ===========================================================================
function ScheduleTab({ schedule, setSchedule, dailyMap }: {
  schedule: WorkSchedule;
  setSchedule: (s: WorkSchedule) => void;
  dailyMap: Map<string, DailyStats>;
}) {
  const { insideMs, outsideMs, outsideDays, weeklyOutside } = useMemo(() => {
    let inside = 0;
    let outside = 0;
    const daysOutside: { date: string; ms: number; weekday: number }[] = [];
    for (const d of dailyMap.values()) {
      inside += d.insideMs;
      outside += d.outsideMs;
      if (d.outsideMs > 0) daysOutside.push({ date: d.date, ms: d.outsideMs, weekday: d.weekday });
    }
    const weeks = buildWeeklySummaries(Array.from(dailyMap.values()));
    return {
      insideMs: inside,
      outsideMs: outside,
      outsideDays: daysOutside.sort((a, b) => b.ms - a.ms).slice(0, 20),
      weeklyOutside: weeks,
    };
  }, [dailyMap]);

  const totalWorkHoursPerWeek = schedule.workDays.filter(Boolean).length * (schedule.endHour - schedule.startHour);
  const toggleDay = (idx: number) => {
    const next = { ...schedule, workDays: schedule.workDays.slice() };
    next.workDays[idx] = !next.workDays[idx];
    setSchedule(next);
  };
  const scopedWeekly = weeklyOutside;
  const maxOutsideH = Math.max(...scopedWeekly.map(w => w.outsideMs / 3_600_000), 1);

  const [customTz, setCustomTz] = useState("");
  const [tzError, setTzError] = useState<string | null>(null);
  const tzOffsetLabel = (() => {
    try {
      const mins = tzOffsetMinutes(schedule.timezone, Date.now());
      const sign = mins >= 0 ? "+" : "-";
      const abs = Math.abs(mins);
      const h = Math.floor(abs / 60);
      const m = abs % 60;
      return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${String(m).padStart(2, "0")}`;
    } catch { return ""; }
  })();

  return (
    <div className="space-y-5">
      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-5 space-y-5">
        <div>
          <h3 className="text-sm font-medium flex items-center gap-2"><Settings2 size={14} /> Work schedule</h3>
          <p className="text-xs text-[var(--text-secondary)] mt-1">
            Pick the timezone, days, and hours you consider regular work. Everything inside this window counts as "inside schedule"; everything else counts as hours beyond your core window.
          </p>
        </div>

        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-2 flex items-center gap-1.5"><Globe size={12} /> Timezone <span className="text-[var(--text-secondary)]/70">({tzOffsetLabel})</span></label>
          <div className="flex flex-wrap gap-2 items-center">
            <select
              value={schedule.timezone}
              onChange={(e) => { setSchedule({ ...schedule, timezone: e.target.value }); setTzError(null); setCustomTz(""); }}
              className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-sm min-w-[240px]"
            >
              {(() => {
                const commonAll = COMMON_TIMEZONES.flatMap(g => g.zones);
                const extra: string[] = commonAll.includes(schedule.timezone) ? [] : [schedule.timezone];
                return (
                  <>
                    {extra.map(tz => <option key={tz} value={tz}>{tz} (current)</option>)}
                    {COMMON_TIMEZONES.map((group) => (
                      <optgroup key={group.region} label={group.region}>
                        {group.zones.map((tz) => (
                          <option key={tz} value={tz}>{tz}</option>
                        ))}
                      </optgroup>
                    ))}
                  </>
                );
              })()}
            </select>
            <button
              onClick={() => { const detected = detectBrowserTimezone(); setSchedule({ ...schedule, timezone: detected }); setTzError(null); setCustomTz(""); }}
              className="px-2 py-1.5 rounded text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] hover:text-[var(--text-primary)] text-[var(--text-secondary)]"
              title="Use your OS/browser timezone"
            >
              Use browser
            </button>
            <div className="flex gap-1 items-center">
              <input
                type="text"
                value={customTz}
                onChange={(e) => setCustomTz(e.target.value)}
                placeholder="Custom IANA zone (e.g. Europe/Zurich)"
                className="bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-sm min-w-[200px]"
              />
              <button
                onClick={() => {
                  if (!customTz.trim()) return;
                  if (isValidTimezone(customTz.trim())) {
                    setSchedule({ ...schedule, timezone: customTz.trim() });
                    setTzError(null);
                    setCustomTz("");
                  } else {
                    setTzError(`Unknown timezone: ${customTz}`);
                  }
                }}
                className="px-2 py-1.5 rounded text-xs bg-[var(--accent)]/15 text-[var(--accent)] border border-[var(--accent)]/40"
              >
                Apply
              </button>
            </div>
          </div>
          {tzError && <p className="text-xs text-amber-400 mt-1">{tzError}</p>}
          <p className="text-[10px] text-[var(--text-secondary)]/70 mt-1">
            Uses IANA zone names (handles DST automatically). Full list: <a href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones" target="_blank" rel="noreferrer" className="underline hover:text-[var(--text-primary)]">tz database</a>.
          </p>
        </div>

        <div>
          <label className="block text-xs text-[var(--text-secondary)] mb-2">Date / time locale</label>
          <div className="flex gap-2 flex-wrap">
            {["en-US", "en-GB", "en-AU", "en-CA", "de-DE", "fr-FR", "es-ES", "ja-JP", "zh-CN"].map((loc) => (
              <button
                key={loc}
                onClick={() => setSchedule({ ...schedule, locale: loc })}
                className={clsx(
                  "px-2 py-1 rounded text-xs border",
                  schedule.locale === loc
                    ? "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40"
                    : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border)] hover:text-[var(--text-primary)]"
                )}
              >
                {loc}
              </button>
            ))}
            <button
              onClick={() => setSchedule({ ...schedule, locale: detectBrowserLocale() })}
              className="px-2 py-1 rounded text-xs bg-[var(--bg-tertiary)] border border-[var(--border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            >
              Use browser ({detectBrowserLocale()})
            </button>
          </div>
        </div>

        <div>
          <div className="text-xs text-[var(--text-secondary)] mb-2">Work days</div>
          <div className="flex gap-2 flex-wrap">
            {DAY_FULL.map((name, i) => (
              <button
                key={i}
                onClick={() => toggleDay(i)}
                className={clsx(
                  "px-3 py-1.5 rounded-md text-xs font-medium border transition-colors",
                  schedule.workDays[i]
                    ? "bg-[var(--accent)]/15 text-[var(--accent)] border-[var(--accent)]/40"
                    : "bg-[var(--bg-tertiary)] text-[var(--text-secondary)] border-[var(--border)] hover:text-[var(--text-primary)]"
                )}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-4 max-w-md">
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1">Start hour</label>
            <select
              value={schedule.startHour}
              onChange={(e) => setSchedule({ ...schedule, startHour: Number(e.target.value) })}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{formatHourLabel(h)}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-[var(--text-secondary)] mb-1">End hour</label>
            <select
              value={schedule.endHour}
              onChange={(e) => setSchedule({ ...schedule, endHour: Number(e.target.value) })}
              className="w-full bg-[var(--bg-tertiary)] border border-[var(--border)] rounded px-2 py-1.5 text-sm"
            >
              {Array.from({ length: 24 }, (_, h) => h + 1).map((h) => <option key={h} value={h}>{formatHourLabel(h)}</option>)}
            </select>
          </div>
        </div>

        <div className="text-xs text-[var(--text-secondary)]">
          Core hours per week: <span className="text-[var(--text-primary)] font-medium">{totalWorkHoursPerWeek}h</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        <ScheduleCard icon={<Calendar size={14} />} label="Inside schedule (all-time)" value={formatDuration(insideMs)} accent="inside" />
        <ScheduleCard icon={<Moon size={14} />} label="Outside schedule (all-time)" value={formatDuration(outsideMs)} accent="outside" />
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h3 className="text-sm font-medium mb-3 text-[var(--text-secondary)]">Outside-schedule hours by week</h3>
        {scopedWeekly.length === 0 ? (
          <div className="text-xs text-[var(--text-secondary)]">No weekly data yet.</div>
        ) : (
          <div className="space-y-1 max-h-[420px] overflow-y-auto pr-1">
            {scopedWeekly.slice().reverse().map((w) => {
              const outsideH = w.outsideMs / 3_600_000;
              const insideH = w.insideMs / 3_600_000;
              const totalH = outsideH + insideH;
              return (
                <div key={w.key} className="flex items-center gap-3 text-xs py-1">
                  <span className="font-mono w-20 text-[var(--text-secondary)] shrink-0">{w.key}</span>
                  <span className="text-[var(--text-secondary)] w-24 shrink-0">wk of {w.mondayStr}</span>
                  <div className="flex-1 h-4 rounded overflow-hidden bg-[var(--bg-tertiary)] relative">
                    {totalH > 0 && (
                      <>
                        <div className="absolute inset-y-0 left-0 bg-emerald-500/70" style={{ width: `${(insideH / maxOutsideH) * 100}%` }} />
                        <div className="absolute inset-y-0 bg-amber-500" style={{ left: `${(insideH / maxOutsideH) * 100}%`, width: `${(outsideH / maxOutsideH) * 100}%` }} />
                      </>
                    )}
                  </div>
                  <span className="text-emerald-400 tabular-nums w-20 text-right">{formatHours(w.insideMs)} in</span>
                  <span className="text-amber-400 tabular-nums w-20 text-right font-medium">{formatHours(w.outsideMs)} out</span>
                  <span className="text-[var(--text-secondary)] tabular-nums w-16 text-right">{w.sessions} s</span>
                </div>
              );
            })}
          </div>
        )}
        <div className="flex items-center gap-4 mt-3 text-[10px] text-[var(--text-secondary)]">
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-emerald-500/70" /> Inside schedule</span>
          <span className="flex items-center gap-1.5"><span className="w-3 h-2 rounded-sm bg-amber-500" /> Outside schedule</span>
        </div>
      </div>

      <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
        <h3 className="text-sm font-medium mb-3 text-[var(--text-secondary)]">Heaviest outside-schedule days</h3>
        {outsideDays.length === 0 ? (
          <div className="text-xs text-[var(--text-secondary)]">No activity outside your configured window. Nice boundary.</div>
        ) : (
          <table className="w-full text-xs">
            <thead className="text-[var(--text-secondary)]">
              <tr>
                <th className="text-left py-1">Date</th>
                <th className="text-left py-1">Day</th>
                <th className="text-right py-1">Outside work</th>
              </tr>
            </thead>
            <tbody>
              {outsideDays.map((d) => (
                <tr key={d.date}>
                  <td className="py-1 font-medium">{d.date}</td>
                  <td className="py-1 text-[var(--text-secondary)]">{DAY_FULL[d.weekday]}</td>
                  <td className="py-1 text-right font-medium text-amber-400">{formatDuration(d.ms)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}

// ===========================================================================
// Shared cards and chips
// ===========================================================================
function StatCard({ icon, label, value, highlight }: { icon: React.ReactNode; label: string; value: string; highlight?: boolean }) {
  return (
    <div className={clsx("border rounded-lg p-3", highlight ? "bg-amber-500/10 border-amber-500/30" : "bg-[var(--bg-secondary)] border-[var(--border)]")}>
      <div className="flex items-center gap-1.5 text-[var(--text-secondary)] text-xs mb-1">
        {icon} {label}
      </div>
      <div className={clsx("text-xl font-semibold tabular-nums", highlight ? "text-amber-400" : "text-[var(--text-primary)]")}>{value}</div>
    </div>
  );
}

function TimeCard({ title, subtitle, value, icon, accent }: { title: string; subtitle: string; value: string; icon: React.ReactNode; accent: "accent" | "neutral" }) {
  return (
    <div className={clsx(
      "border rounded-lg p-4",
      accent === "accent" ? "bg-[var(--accent)]/10 border-[var(--accent)]/30" : "bg-[var(--bg-secondary)] border-[var(--border)]"
    )}>
      <div className="flex items-center gap-2 text-xs font-medium uppercase tracking-wide mb-1 text-[var(--text-secondary)]">
        {icon} {title}
      </div>
      <div className={clsx("text-3xl font-semibold tabular-nums mb-1", accent === "accent" ? "text-[var(--accent)]" : "text-[var(--text-primary)]")}>{value}</div>
      <div className="text-xs text-[var(--text-secondary)]">{subtitle}</div>
    </div>
  );
}

function ScheduleCard({ icon, label, value, accent }: { icon: React.ReactNode; label: string; value: string; accent: "inside" | "outside" }) {
  return (
    <div className={clsx(
      "border rounded-lg p-3",
      accent === "inside" ? "bg-emerald-500/10 border-emerald-500/30" : "bg-amber-500/10 border-amber-500/30"
    )}>
      <div className="flex items-center gap-1.5 text-xs mb-1 text-[var(--text-secondary)]">
        {icon} {label}
      </div>
      <div className={clsx("text-xl font-semibold tabular-nums", accent === "inside" ? "text-emerald-400" : "text-amber-400")}>{value}</div>
    </div>
  );
}

function FacetPanel({ title, data, total, compact }: { title: string; data: Record<string, number>; total: number; compact?: boolean }) {
  const entries = Object.entries(data).sort((a, b) => b[1] - a[1]);
  const maxCount = Math.max(...entries.map(([, v]) => v), 1);
  const sliceLen = compact ? 6 : entries.length;
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
      <h3 className="text-sm font-medium text-[var(--text-secondary)] mb-3">{title}</h3>
      <div className="space-y-2.5">
        {entries.slice(0, sliceLen).map(([name, count]) => {
          const pct = Math.round((count / Math.max(total, 1)) * 100);
          return (
            <div key={name}>
              <div className="flex items-center justify-between text-xs mb-1">
                <span className="flex items-center gap-1.5 text-[var(--text-primary)] truncate">
                  <FacetDot name={name} />
                  <span className="truncate">{name}</span>
                </span>
                <span className="text-[var(--text-secondary)] tabular-nums shrink-0 ml-2">{count} ({pct}%)</span>
              </div>
              <div className="h-1.5 bg-[var(--bg-tertiary)] rounded-full overflow-hidden">
                <div className={clsx("h-full rounded-full", FACET_COLORS[name] || "bg-indigo-500")} style={{ width: `${(count / maxCount) * 100}%` }} />
              </div>
            </div>
          );
        })}
        {entries.length > sliceLen && (
          <div className="text-[10px] text-[var(--text-secondary)] pt-1">+ {entries.length - sliceLen} more</div>
        )}
      </div>
    </div>
  );
}

function FacetDot({ name }: { name: string }) {
  const color = FACET_COLORS[name] || "bg-indigo-500";
  return <span className={clsx("w-2 h-2 rounded-full shrink-0", color)} />;
}

function LongExecutionsPanel({ list, tz, locale }: { list: LongExecution[]; tz: string; locale: string }) {
  const [expanded, setExpanded] = useState(false);
  const totalMs = list.reduce((s, r) => s + r.durationMs, 0);
  const top = expanded ? list : list.slice(0, 10);
  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-4">
      <div className="flex items-start gap-2">
        <AlertTriangle size={14} className="text-amber-400 mt-0.5 shrink-0" />
        <div className="flex-1">
          <h3 className="text-sm font-medium">Long-running executions (over 4 hours)</h3>
          <p className="text-xs text-[var(--text-secondary)] mt-0.5">
            {list.length} execution{list.length === 1 ? "" : "s"} totalling {formatDuration(totalMs)}. <span className="text-[var(--text-primary)]">These are counted in all totals above.</span> Listed here so you can audit them — a single execution can legitimately be long if a spec task ran unattended overnight.
          </p>
        </div>
      </div>
      <div className="mt-3 overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-[var(--text-secondary)]">
            <tr>
              <th className="text-right py-1 pr-3">Duration</th>
              <th className="text-left py-1 pr-3">Start</th>
              <th className="text-left py-1 pr-3">End</th>
              <th className="text-left py-1 pr-3">Workspace</th>
              <th className="text-left py-1 pr-3">exec id</th>
              <th className="text-left py-1">source</th>
            </tr>
          </thead>
          <tbody>
            {top.map((r, i) => (
              <tr key={i}>
                <td className="py-1 pr-3 text-right font-medium text-amber-400 tabular-nums">{formatDuration(r.durationMs)}</td>
                <td className="py-1 pr-3 font-mono">{formatTimeInTz(r.start, tz, locale)} · {tzDateKey(tz, r.start)}</td>
                <td className="py-1 pr-3 font-mono">{formatTimeInTz(r.end, tz, locale)} · {tzDateKey(tz, r.end)}</td>
                <td className="py-1 pr-3 truncate max-w-[180px]">{r.workspace}</td>
                <td className="py-1 pr-3 font-mono text-[var(--text-secondary)]">{r.executionId}</td>
                <td className="py-1 text-[var(--text-secondary)]">{r.source}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {list.length > 10 && (
        <button onClick={() => setExpanded((v) => !v)} className="mt-2 text-xs text-[var(--accent)] hover:text-[var(--accent-hover)]">
          {expanded ? `Show top 10` : `Show all ${list.length}`}
        </button>
      )}
    </div>
  );
}

// ===========================================================================
// WeekAudit — per-day clock-in / clock-out / active / raw / peak-parallel
// table. Lets the user see exactly what day contributed what, and where the
// gap between active and raw totals comes from.
// ===========================================================================
function WeekAudit({ weekDays, executions, tz, locale }: {
  weekDays: string[];
  executions: ExecutionRow[];
  tz: string;
  locale: string;
}) {
  const rows = useMemo(() => {
    function peak(intervals: [number, number][]): number {
      if (!intervals.length) return 0;
      const events: [number, number][] = [];
      for (const [a, b] of intervals) { events.push([a, 1]); events.push([b, -1]); }
      events.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
      let p = 0, cur = 0;
      for (const [, d] of events) { cur += d; if (cur > p) p = cur; }
      return p;
    }
    function merge(intervals: [number, number][]): number {
      if (!intervals.length) return 0;
      const s = intervals.slice().sort((a, b) => a[0] - b[0]);
      let total = 0, curS = s[0][0], curE = s[0][1];
      for (let i = 1; i < s.length; i++) {
        const [a, b] = s[i];
        if (a <= curE) { if (b > curE) curE = b; }
        else { total += curE - curS; curS = a; curE = b; }
      }
      return total + (curE - curS);
    }

    return weekDays.map((dayKey) => {
      const [dayStart, dayEnd] = tzDayBoundariesUtc(tz, dayKey);
      const active: [number, number][] = [];
      const raw: [number, number][] = [];
      let execCount = 0;
      let clockIn: number | null = null;
      let clockOut: number | null = null;
      for (const e of executions) {
        const rawEnd = e.endRaw ?? e.end;
        const touchesActive = e.start < dayEnd && e.end > dayStart;
        const touchesRaw = e.start < dayEnd && rawEnd > dayStart;
        if (!touchesActive && !touchesRaw) continue;
        execCount++;
        if (touchesActive) {
          const s = Math.max(e.start, dayStart);
          const f = Math.min(e.end, dayEnd);
          if (f > s) {
            active.push([s, f]);
            if (clockIn === null || s < clockIn) clockIn = s;
            if (clockOut === null || f > clockOut) clockOut = f;
          }
        }
        if (touchesRaw) {
          const s = Math.max(e.start, dayStart);
          const f = Math.min(rawEnd, dayEnd);
          if (f > s) raw.push([s, f]);
        }
      }
      return {
        dayKey, execCount, clockIn, clockOut,
        activeMs: merge(active),
        rawMs: merge(raw),
        peakActive: peak(active),
        peakRaw: peak(raw),
      };
    });
  }, [weekDays, executions, tz]);

  const weekdayShort = (dayKey: string) => {
    const [y, m, d] = dayKey.split("-").map(Number);
    return DAY_LABELS[new Date(y, m - 1, d).getDay()];
  };

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg overflow-hidden">
      <div className="px-3 py-2 border-b border-[var(--border)] flex items-center justify-between">
        <div className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-2">
          <Calendar size={13} /> Week audit (per day)
        </div>
        <div className="text-[10px] text-[var(--text-secondary)]">
          active = clamped &middot; raw = Kiro's original endTime
        </div>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs tabular-nums">
          <thead className="text-[var(--text-secondary)]">
            <tr className="border-b border-[var(--border)]">
              <th className="text-left px-3 py-2">Day</th>
              <th className="text-right px-2 py-2">Execs</th>
              <th className="text-right px-2 py-2">Clock in</th>
              <th className="text-right px-2 py-2">Clock out</th>
              <th className="text-right px-2 py-2">Active</th>
              <th className="text-right px-2 py-2">Raw</th>
              <th className="text-right px-2 py-2">Peak // (active)</th>
              <th className="text-right px-3 py-2">Peak // (raw)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.dayKey} className="border-b border-[var(--border)]/50 last:border-b-0">
                <td className="px-3 py-1.5">
                  <span className="text-[var(--text-secondary)] mr-1">{weekdayShort(r.dayKey)}</span>
                  <span className="font-medium">{r.dayKey.slice(5)}</span>
                </td>
                <td className="text-right px-2">{r.execCount || "—"}</td>
                <td className="text-right px-2">{r.clockIn ? formatTimeInTz(r.clockIn, tz, locale) : "—"}</td>
                <td className="text-right px-2">{r.clockOut ? formatTimeInTz(r.clockOut, tz, locale) : "—"}</td>
                <td className="text-right px-2 text-emerald-300">{r.activeMs ? formatDuration(r.activeMs) : "—"}</td>
                <td className={clsx("text-right px-2", r.rawMs > r.activeMs * 2 && "text-amber-400")}>
                  {r.rawMs ? formatDuration(r.rawMs) : "—"}
                </td>
                <td className="text-right px-2">{r.peakActive || "—"}</td>
                <td className="text-right px-3">{r.peakRaw || "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ===========================================================================
// WeekConcurrencyStrip — minute-by-minute bar of how many executions were
// running simultaneously across the selected week. Uses active ends.
// ===========================================================================
function WeekConcurrencyStrip({ weekDays, executions, tz }: {
  weekDays: string[];
  executions: ExecutionRow[];
  tz: string;
}) {
  const { minutes, peak } = useMemo(() => {
    if (!weekDays.length) return { minutes: new Uint16Array(0), peak: 0 };
    const [ys, ms, ds] = weekDays[0].split("-").map(Number);
    const guessMs = Date.UTC(ys, ms - 1, ds);
    const offsetMin = tzOffsetMinutes(tz, guessMs);
    const weekStartMs = guessMs - offsetMin * 60_000;
    const totalMinutes = 7 * 24 * 60;
    const counts = new Uint16Array(totalMinutes);
    for (const e of executions) {
      if (e.end <= weekStartMs) continue;
      if (e.start >= weekStartMs + totalMinutes * 60_000) continue;
      const startMin = Math.max(0, Math.floor((e.start - weekStartMs) / 60_000));
      const endMin = Math.min(totalMinutes, Math.ceil((e.end - weekStartMs) / 60_000));
      for (let i = startMin; i < endMin; i++) counts[i]++;
    }
    let p = 0;
    for (let i = 0; i < totalMinutes; i++) if (counts[i] > p) p = counts[i];
    return { minutes: counts, peak: p };
  }, [weekDays, executions, tz]);

  if (!minutes.length) return null;

  const totalMinutes = minutes.length;
  const dayWidthPct = 100 / 7;

  return (
    <div className="bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg p-3">
      <div className="flex items-center justify-between mb-2">
        <div className="text-xs font-medium text-[var(--text-secondary)] flex items-center gap-2">
          <Activity size={13} /> Concurrent sessions, minute-by-minute (active)
        </div>
        <div className="text-[10px] text-[var(--text-secondary)]">peak this week: {peak}</div>
      </div>
      <div className="relative">
        <div className="flex h-12 bg-[var(--bg-tertiary)] rounded overflow-hidden" style={{ position: "relative" }}>
          {Array.from({ length: totalMinutes }, (_, i) => {
            const c = minutes[i];
            if (!c) return null;
            const opacity = peak > 0 ? 0.25 + 0.75 * (c / peak) : 0;
            const leftPct = (i / totalMinutes) * 100;
            const widthPct = (1 / totalMinutes) * 100;
            return (
              <div
                key={i}
                className="absolute bottom-0 bg-emerald-400"
                style={{
                  left: `${leftPct}%`,
                  width: `${widthPct}%`,
                  height: `${Math.max(6, (c / Math.max(peak, 1)) * 100)}%`,
                  opacity,
                }}
                title={`Minute ${i}: ${c} parallel exec${c === 1 ? "" : "s"}`}
              />
            );
          })}
        </div>
        <div className="flex mt-1 text-[10px] text-[var(--text-secondary)]">
          {weekDays.map((k) => (
            <div key={k} style={{ width: `${dayWidthPct}%` }} className="text-center">
              {k.slice(8)}
            </div>
          ))}
        </div>
      </div>
      <div className="text-[10px] text-[var(--text-secondary)] mt-1">
        Brighter bar = more executions running in that minute. Hover any spike for the exact count.
      </div>
    </div>
  );
}

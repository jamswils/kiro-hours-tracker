// Store-agnostic helpers shared by the server, the scan worker and both store
// adapters. Nothing here knows about a particular on-disk layout.

import path from "path";

// ---------------------------------------------------------------------------
// Path containment
// ---------------------------------------------------------------------------

/**
 * Join untrusted segments onto baseDir and return the result ONLY if it stays
 * inside baseDir. Returns null for anything that escapes (`..`, absolute
 * segments, encoded traversal that path.resolve collapses outward).
 *
 * The session-detail route takes both the workspace id and the session id
 * straight from the URL; without this, `..` segments turn the route into an
 * arbitrary-file read. Centralised so every store adapter gets the same guard
 * instead of each re-deriving it.
 */
export function resolveContained(baseDir: string, ...segments: string[]): string | null {
  const base = path.resolve(baseDir);
  for (const seg of segments) {
    // A NUL byte truncates the path inside libc; reject before it reaches fs.
    if (seg.includes("\0")) return null;
  }
  const candidate = path.resolve(base, ...segments);
  if (candidate === base) return null; // must be something *inside* the base
  if (!candidate.startsWith(base + path.sep)) return null;
  return candidate;
}

// ---------------------------------------------------------------------------
// Defensive JSON reading
// ---------------------------------------------------------------------------
// Both stores contain fields whose types vary between records (older writers
// emitted numbers as strings). These coerce without throwing and without the
// `any` casts that used to pepper the scanner.

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Number(), but never NaN/Infinity — returns fallback instead. */
export function num(value: unknown, fallback = 0): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : fallback;
  if (typeof value === "string" && value.trim() !== "") {
    const n = Number(value);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

export function str(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return fallback;
}

/** Parse an ISO-8601 timestamp to epoch ms, or 0 when unparseable. */
export function isoToMs(value: unknown): number {
  if (typeof value === "number") return Number.isFinite(value) ? value : 0;
  if (typeof value !== "string" || value.trim() === "") return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

/** JSON.parse that yields null instead of throwing. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** Last path segment of a workspace path, for display. */
export function projectNameFromPath(decodedPath: string): string {
  return decodedPath.split(/[\\/]/).filter(Boolean).pop() || decodedPath;
}

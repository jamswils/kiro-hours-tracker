// Subprocess that scans a session store and prints the dashboard payload as
// JSON on stdout.
//
// Design: this file emits RAW execution and session records (UTC timestamps
// plus metadata). All timezone-dependent bucketing (per-day, per-week,
// inside/outside schedule) happens client-side in Dashboard.tsx so the same
// payload can drive any user's configured timezone without a rescan.
//
// Everything layout-specific now lives behind the store seam
// (server/stores/); the aggregation maths lives in server/aggregate.ts. This
// file is only argv handling plus wiring.
//
// Argv:
//   scan-worker.ts --store=<id> [extraSource ...]
//   scan-worker.ts <globalStorage> <sessionsDir> [extraSource ...]   (legacy)
//
// The legacy positional form is still accepted so an older caller keeps
// working: it always means the Kiro store, and <globalStorage> overrides the
// platform default. <sessionsDir> is ignored because the store derives it.

import { createScanCollector } from "./aggregate";
import { createStore, isStoreId, resolveStoreId } from "./stores/select";
import type { StoreId } from "./stores/store";

function parseArgs(argv: string[]): { storeId: StoreId; extraSources: string[] } {
  const first = argv[2];

  if (first && first.startsWith("--store=")) {
    const requested = first.slice("--store=".length);
    const storeId = isStoreId(requested) ? requested : resolveStoreId(requested);
    return { storeId, extraSources: argv.slice(3).filter(Boolean) };
  }

  if (first) {
    // Legacy positional form: <globalStorage> <sessionsDir> [extras...]
    process.env.KIRO_GLOBAL_STORAGE = first;
    return { storeId: "kiro", extraSources: argv.slice(4).filter(Boolean) };
  }

  return { storeId: resolveStoreId(), extraSources: [] };
}

async function main() {
  const { storeId, extraSources } = parseArgs(process.argv);
  const store = createStore(storeId);
  const collector = createScanCollector();
  await store.scan(collector.sink, extraSources);
  process.stdout.write(JSON.stringify(collector.finalize()));
}

main().catch((e: unknown) => {
  console.error("[scan-worker] failed:", e instanceof Error ? e.stack || e.message : String(e));
  process.exit(1);
});

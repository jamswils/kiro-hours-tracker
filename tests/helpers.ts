import path from "path";
import { fileURLToPath } from "url";
import { createScanCollector } from "../server/aggregate";
import type { ScanResult } from "../server/types";
import type { SessionStore } from "../server/stores/store";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FIXTURES = path.join(here, "fixtures");
export const KIRO_FIXTURE_ROOT = path.join(FIXTURES, "kiro");
export const KIROCREW_FIXTURE_ROOT = path.join(FIXTURES, "kirocrew");

/** The workspace path the Kiro fixture's base64url directory decodes to. */
export const KIRO_FIXTURE_WORKSPACE_PATH = "/tmp/kiro-fixture-ws";
export const KIRO_FIXTURE_WORKSPACE_ID = "L3RtcC9raXJvLWZpeHR1cmUtd3M";
export const KIRO_FIXTURE_WORKSPACE_NAME = "kiro-fixture-ws";

/** Run a full scan against a store and return the finalized payload. */
export async function scanStore(store: SessionStore, extraSources: string[] = []): Promise<ScanResult> {
  const collector = createScanCollector();
  await store.scan(collector.sink, extraSources);
  return collector.finalize();
}

export function execById(result: ScanResult, executionId: string) {
  return result.executions.find((e) => e.executionId === executionId);
}

export function workspaceByName(result: ScanResult, name: string) {
  return result.workspaces.find((w) => w.name === name);
}

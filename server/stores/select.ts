// Store selection.
//
// KIRO_STORE=kiro | kirocrew | auto   (default auto)
//   auto: the Kiro IDE store if its session directory exists, else the
//   KiroCrew store if ~/.kiro/crew/sessions exists, else the Kiro store (so
//   /api/health reports a concrete, actionable path rather than nothing).

import { KiroFsStore } from "./kiro-fs";
import { KirocrewStore } from "./kirocrew";
import type { SessionStore, StoreId } from "./store";

export const STORE_IDS: StoreId[] = ["kiro", "kirocrew"];

export function isStoreId(value: string): value is StoreId {
  return (STORE_IDS as string[]).includes(value);
}

export function createStore(id: StoreId): SessionStore {
  return id === "kirocrew" ? new KirocrewStore() : new KiroFsStore();
}

/**
 * Resolve the store id to use. `requested` defaults to process.env.KIRO_STORE.
 * An unrecognised value falls back to auto-detection rather than throwing —
 * a typo should not stop the server from starting, and /api/health names the
 * store that actually got selected.
 */
export function resolveStoreId(requested: string | undefined = process.env.KIRO_STORE): StoreId {
  const want = (requested || "auto").trim().toLowerCase();
  if (isStoreId(want)) return want;
  if (new KiroFsStore().isAvailable()) return "kiro";
  if (new KirocrewStore().isAvailable()) return "kirocrew";
  return "kiro";
}

export function selectStore(requested?: string): SessionStore {
  return createStore(resolveStoreId(requested));
}

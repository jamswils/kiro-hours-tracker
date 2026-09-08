import { describe, expect, it } from "vitest";
import { KiroFsStore } from "../server/stores/kiro-fs";
import { KirocrewStore } from "../server/stores/kirocrew";
import { createStore, isStoreId, resolveStoreId } from "../server/stores/select";

describe("store selection", () => {
  it("recognises the two store ids", () => {
    expect(isStoreId("kiro")).toBe(true);
    expect(isStoreId("kirocrew")).toBe(true);
    expect(isStoreId("auto")).toBe(false);
    expect(isStoreId("nonsense")).toBe(false);
  });

  it("honours an explicit request", () => {
    expect(resolveStoreId("kiro")).toBe("kiro");
    expect(resolveStoreId("kirocrew")).toBe("kirocrew");
    expect(resolveStoreId("  KiroCrew  ")).toBe("kirocrew");
  });

  it("falls back to auto-detection for auto, empty and typo'd values", () => {
    // Whatever this host has, the answer must be a real store id rather than
    // a throw — a typo must not stop the server from starting.
    for (const input of ["auto", "", undefined, "kirocrw"]) {
      expect(isStoreId(resolveStoreId(input))).toBe(true);
    }
  });

  it("builds the matching adapter", () => {
    expect(createStore("kiro")).toBeInstanceOf(KiroFsStore);
    expect(createStore("kirocrew")).toBeInstanceOf(KirocrewStore);
    expect(createStore("kiro").id).toBe("kiro");
    expect(createStore("kirocrew").id).toBe("kirocrew");
  });
});

import path from "path";
import { describe, expect, it } from "vitest";
import { resolveContained } from "../server/util";
import { KiroFsStore } from "../server/stores/kiro-fs";
import { KirocrewStore } from "../server/stores/kirocrew";
import { KIROCREW_FIXTURE_ROOT, KIRO_FIXTURE_ROOT, KIRO_FIXTURE_WORKSPACE_ID } from "./helpers";

const BASE = "/srv/store/workspace-sessions";

describe("resolveContained", () => {
  it("accepts a plain child path", () => {
    expect(resolveContained(BASE, "ws1", "sess.json"))
      .toBe(path.resolve(BASE, "ws1", "sess.json"));
  });

  it("rejects a parent traversal in the first segment", () => {
    expect(resolveContained(BASE, "..", "secrets.json")).toBeNull();
    expect(resolveContained(BASE, "../..", "secrets.json")).toBeNull();
  });

  it("rejects a traversal buried mid-segment", () => {
    expect(resolveContained(BASE, "ws1/../../../etc", "passwd.json")).toBeNull();
    expect(resolveContained(BASE, "ws1", "../../../../etc/passwd.json")).toBeNull();
  });

  it("rejects an absolute segment that would replace the base", () => {
    expect(resolveContained(BASE, "/etc", "passwd.json")).toBeNull();
  });

  it("rejects the base directory itself", () => {
    expect(resolveContained(BASE, ".")).toBeNull();
    expect(resolveContained(BASE, "")).toBeNull();
  });

  it("rejects a NUL byte before it reaches the filesystem", () => {
    expect(resolveContained(BASE, "ws1\0", "sess.json")).toBeNull();
  });

  it("does not confuse a sibling directory with a prefix match", () => {
    // /srv/store/workspace-sessions-evil must not be treated as inside
    // /srv/store/workspace-sessions.
    expect(resolveContained(BASE, "..", "workspace-sessions-evil", "x.json")).toBeNull();
  });

  it("allows a nested child several levels deep", () => {
    expect(resolveContained(BASE, "ws1", "sub", "deep.json"))
      .toBe(path.resolve(BASE, "ws1", "sub", "deep.json"));
  });
});

describe("store routes reject traversal params", () => {
  it("kiro store refuses ../ in either param", async () => {
    const store = new KiroFsStore(KIRO_FIXTURE_ROOT);
    expect(await store.readSessionDetail("..", "package")).toBeNull();
    expect(await store.readSessionDetail(KIRO_FIXTURE_WORKSPACE_ID, "../../../package")).toBeNull();
    expect(await store.readSessionDetail("../../..", "../../../../etc/passwd")).toBeNull();
  });

  it("kirocrew store refuses ../ in the session id", async () => {
    const store = new KirocrewStore(KIROCREW_FIXTURE_ROOT);
    expect(await store.readSessionDetail("ws", "../archive/dashboard_chat-1-100__19980101-000000"))
      .toBeNull();
    expect(await store.readSessionDetail("ws", "../../../etc/passwd")).toBeNull();
  });

  it("kiro store still serves a legitimate session after the guard", async () => {
    const store = new KiroFsStore(KIRO_FIXTURE_ROOT);
    const ok = await store.readSessionDetail(KIRO_FIXTURE_WORKSPACE_ID, "sess-alpha");
    expect(ok?.sessionId).toBe("sess-alpha");
  });
});

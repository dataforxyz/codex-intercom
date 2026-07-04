import test from "node:test";
import assert from "node:assert/strict";
import { createDefaultIdentity, parseCoiArgs, sanitizeSegment } from "./coi.ts";

test("sanitizeSegment keeps readable safe ids", () => {
  assert.equal(sanitizeSegment("Codex:Repo Main#123"), "codex:repo-main-123");
  assert.equal(sanitizeSegment(""), "codex");
});

test("createDefaultIdentity derives readable per-process defaults", () => {
  const identity = createDefaultIdentity({
    cwd: "/home/me/src/project",
    pid: 1234,
    gitRoot: "/home/me/src/project",
    branch: "main",
  });
  assert.match(identity.id, /^codex-project-main-[a-f0-9]{8}-1234$/);
  assert.equal(identity.name, "codex:project:main#1234");
});

test("parseCoiArgs consumes sidecar options and passes codex args through", () => {
  const parsed = parseCoiArgs([
    "--name", "worker",
    "--id=worker-1",
    "--no-tui",
    "--profile", "cliproxy",
    "-m", "gpt-test",
  ], {});

  assert.equal(parsed.name, "worker");
  assert.equal(parsed.id, "worker-1");
  assert.equal(parsed.noTui, true);
  assert.deepEqual(parsed.codexArgs, ["--profile", "cliproxy", "-m", "gpt-test"]);
});

test("parseCoiArgs leaves everything after separator for codex", () => {
  const parsed = parseCoiArgs([
    "--intercom-name", "sidecar",
    "--",
    "--name", "not-sidecar",
  ], {});

  assert.equal(parsed.name, "sidecar");
  assert.deepEqual(parsed.codexArgs, ["--name", "not-sidecar"]);
});

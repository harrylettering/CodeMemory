/**
 * Workspace qualification tests.
 *
 * File tags are stored as `<sha256(workspaceRoot)[:8]>:<relative-path>` so that
 * `/abs/repo/src/a.ts` and `src/a.ts` land on one anchor, and so that two repos
 * with a `src/index.ts` do not share one.
 *
 * Both properties depend on workspaceRoot being the project directory. It
 * resolves from CODEMEMORY_WORKSPACE_ROOT, falling back to `process.cwd()` --
 * and the daemon's cwd is the plugin install directory, which is the same path
 * for every project on the machine. Nothing set the variable, so in production
 * every repository hashed to one key: tags from different projects collided,
 * and absolute paths failed to relativize and were stored unqualified.
 *
 * The TypeScript here was always correct. The defect was entirely in the shell
 * that spawns it, which is why the last group of tests reads the hook scripts.
 */

import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { qualifyFileTag } from "../src/retrieval-plan.js";

const REPO_A = "/tmp/codememory-test/project-a";
const REPO_B = "/tmp/codememory-test/project-b";

const keyFor = (root: string) =>
  createHash("sha256").update(root).digest("hex").slice(0, 8);

afterEach(() => {
  delete process.env.CODEMEMORY_WORKSPACE_ROOT;
});

describe("qualifyFileTag", () => {
  it("prefers CODEMEMORY_WORKSPACE_ROOT over the process cwd", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    expect(qualifyFileTag("src/a.ts")).toBe(`${keyFor(REPO_A)}:src/a.ts`);
    expect(qualifyFileTag("src/a.ts")).not.toContain(keyFor(process.cwd()));
  });

  it("collapses an absolute path and its relative form onto one anchor", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    expect(qualifyFileTag(join(REPO_A, "src/a.ts"))).toBe(
      qualifyFileTag("src/a.ts")
    );
  });

  it("keeps two projects apart", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    const a = qualifyFileTag("src/index.ts");
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_B;
    const b = qualifyFileTag("src/index.ts");
    expect(a).not.toBe(b);
  });

  it("recomputes when the root changes rather than serving a cached key", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    expect(qualifyFileTag("x.ts")).toBe(`${keyFor(REPO_A)}:x.ts`);
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_B;
    expect(qualifyFileTag("x.ts")).toBe(`${keyFor(REPO_B)}:x.ts`);
  });

  it("leaves an already-qualified tag untouched", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    const tag = `${keyFor(REPO_B)}:src/a.ts`;
    expect(qualifyFileTag(tag)).toBe(tag);
  });

  it("returns a path outside the workspace unqualified", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    expect(qualifyFileTag("/etc/hosts")).toBe("/etc/hosts");
  });

  it("passes an empty path through", () => {
    process.env.CODEMEMORY_WORKSPACE_ROOT = REPO_A;
    expect(qualifyFileTag("   ")).toBe("");
  });
});

/**
 * Guards the actual defect. Both scripts run node from a directory that is not
 * the project, so each has to hand the project directory over explicitly.
 */
describe("hook scripts export the workspace root", () => {
  const read = (name: string) =>
    readFileSync(join(__dirname, "..", "hooks", "scripts", name), "utf-8");

  it("ensure-daemon.sh exports it before changing directory", () => {
    // The spawn moved out of session-start.sh once the daemon gained an idle
    // exit and hooks had to be able to bring one back. The ordering rule
    // travelled with it: the `cd` is what destroys the useful cwd.
    const script = read("ensure-daemon.sh");
    const exportAt = script.indexOf("export CODEMEMORY_WORKSPACE_ROOT=");
    const cdAt = script.indexOf('cd "${CLAUDE_PLUGIN_ROOT}"');
    expect(exportAt).toBeGreaterThan(-1);
    expect(cdAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(cdAt);
    expect(script).toContain('export CODEMEMORY_WORKSPACE_ROOT="$CWD"');
  });

  it("every path that spawns a daemon goes through that one script", () => {
    // A second spawn site would be a second chance to forget the export, which
    // is the whole way this bug happened the first time.
    for (const name of ["session-start.sh", "user-prompt-submit.sh"]) {
      const script = read(name);
      expect(script).toContain("ensure-daemon.sh");
      expect(script).not.toContain("daemon.js start");
    }
  });

  it("pre-tool-use.sh exports it before the cold-start CLI runs", () => {
    const script = read("pre-tool-use.sh");
    const exportAt = script.indexOf("export CODEMEMORY_WORKSPACE_ROOT=");
    const cliAt = script.indexOf("dist/failure-lookup-cli.js");
    expect(exportAt).toBeGreaterThan(-1);
    expect(cliAt).toBeGreaterThan(-1);
    expect(exportAt).toBeLessThan(cliAt);
  });

  it("every spawning or reading path takes the project directory from the payload", () => {
    for (const name of [
      "session-start.sh",
      "pre-tool-use.sh",
      "user-prompt-submit.sh",
    ]) {
      expect(read(name)).toMatch(/CWD=\$\(.*\.cwd \/\/ ""'\)/);
    }
  });
});

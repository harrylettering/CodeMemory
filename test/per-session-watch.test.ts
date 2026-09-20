/**
 * A daemon watches its own session's transcripts, not the project's.
 *
 * The process is per-session; the watching was per-project. The watch path is
 * derived from the project directory and the only filter was "ends in .jsonl",
 * so three sessions in one project meant three processes reading every
 * transcript in it.
 *
 * That is the root of the duplicate ingestion measured live: 910 rows from a
 * 776-line transcript. A unique index now refuses the duplicate row, but the
 * work still happens three times, and everything downstream of the message
 * insert -- failure nodes, telemetry, fix-attempt spans -- still runs again.
 *
 * The mechanism was already there. jsonl-watcher has always accepted a filter
 * and the layer above it never passed one.
 *
 * Subagent files are the reason the filter cannot look at file names alone:
 * they are called `agent-<agentId>.jsonl` and carry no session id. The
 * ownership lives in the path, in the `<sessionId>/subagents/` segment.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { ProjectWatcher } from "../src/hooks/project-watcher-manager.js";

let root: string;
let projectDir: string;
let savedHome: string | undefined;

const SILENT = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

const MINE = "sess-mine";
const THEIRS = "sess-theirs";

const line = (id: string, sessionId: string) =>
  JSON.stringify({
    uuid: id,
    type: "user",
    message: { role: "user", content: id },
    sessionId,
    timestamp: new Date().toISOString(),
  }) + "\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codememory-scope-"));
  savedHome = process.env.HOME;
  process.env.HOME = root;
  projectDir = join(root, ".claude", "projects", "-tmp-proj");
  mkdirSync(projectDir, { recursive: true });
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

async function watchAs(sessionId: string): Promise<string[]> {
  const seen: string[] = [];
  const w = new ProjectWatcher(SILENT, {
    projectPath: "/tmp/proj",
    sessionId,
    pollInterval: 50,
    onMessage: (m) => {
      seen.push(m.id);
    },
  });
  await w.start();
  await new Promise((r) => setTimeout(r, 300));
  await w.stop();
  return seen;
}

describe("a watcher reads only its own session", () => {
  it("ignores another session's transcript in the same project", async () => {
    writeFileSync(join(projectDir, `${MINE}.jsonl`), line("mine-1", MINE));
    writeFileSync(join(projectDir, `${THEIRS}.jsonl`), line("theirs-1", THEIRS));

    const seen = await watchAs(MINE);

    expect(seen).toContain("mine-1");
    expect(seen).not.toContain("theirs-1");
  });

  it("still reads its own subagents", async () => {
    writeFileSync(join(projectDir, `${MINE}.jsonl`), line("mine-1", MINE));
    const subagents = join(projectDir, MINE, "subagents");
    mkdirSync(subagents, { recursive: true });
    writeFileSync(join(subagents, "agent-abc.jsonl"), line("mine-sub", MINE));

    const seen = await watchAs(MINE);

    expect(seen).toContain("mine-sub");
  });

  it("ignores another session's subagents", async () => {
    // The file is called agent-<id>.jsonl in both cases. Only the directory
    // it sits in says whose it is, so a name-based filter cannot tell them
    // apart.
    const theirSubagents = join(projectDir, THEIRS, "subagents");
    mkdirSync(theirSubagents, { recursive: true });
    writeFileSync(join(theirSubagents, "agent-xyz.jsonl"), line("theirs-sub", THEIRS));
    writeFileSync(join(projectDir, `${MINE}.jsonl`), line("mine-1", MINE));

    const seen = await watchAs(MINE);

    expect(seen).toContain("mine-1");
    expect(seen).not.toContain("theirs-sub");
  });

  it("is not fooled by a name that merely starts with the session id", async () => {
    writeFileSync(join(projectDir, `${MINE}.jsonl`), line("mine-1", MINE));
    writeFileSync(join(projectDir, `${MINE}-backup.jsonl`), line("backup-1", MINE));

    const seen = await watchAs(MINE);

    expect(seen).toContain("mine-1");
    expect(seen).not.toContain("backup-1");
  });

  it("picks up a transcript that appears after it started", async () => {
    // SessionStart can fire before the transcript exists, and a subagent
    // directory is not created until the first subagent runs. Polling is what
    // makes that work; the filter must not turn it into a one-shot check.
    const w = new ProjectWatcher(SILENT, {
      projectPath: "/tmp/proj",
      sessionId: MINE,
      pollInterval: 50,
      onMessage: (m) => seen.push(m.id),
    });
    const seen: string[] = [];
    await w.start();
    await new Promise((r) => setTimeout(r, 120));
    writeFileSync(join(projectDir, `${MINE}.jsonl`), line("late-1", MINE));
    await new Promise((r) => setTimeout(r, 300));
    await w.stop();

    expect(seen).toContain("late-1");
  });
});

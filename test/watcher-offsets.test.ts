/**
 * Durable watcher offsets.
 *
 * How far each transcript has been read lived only in process memory, so a
 * restart had two options and both lost something. Rewinding to 0 re-emitted
 * every prefix, and since nothing dedupes on the way in, a static 10-line
 * transcript became 10 rows, then 20, then 30. Seeding to the end instead --
 * the mitigation that shipped -- silently drops whatever arrived while the
 * process was down.
 *
 * That second cost is paid on every `--resume`, every crash recovery and every
 * plugin upgrade, and it would be paid far more often once the daemon is
 * allowed to exit when idle. These tests pin the third option: a restart
 * continues from where the previous process stopped.
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  ProjectWatcher,
  type WatcherOffsetStore,
} from "../src/hooks/project-watcher-manager.js";

let root: string;
let projectDir: string;
let transcript: string;
let savedHome: string | undefined;
const SILENT = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as any;

/** In-memory stand-in for the daemon's table-backed store. */
function makeStore(): WatcherOffsetStore & { rows: Map<string, number> } {
  const rows = new Map<string, number>();
  return {
    rows,
    async load() {
      return new Map(rows);
    },
    async save(filePath, charOffset) {
      rows.set(filePath, charOffset);
    },
  };
}

const line = (i: number) =>
  JSON.stringify({
    uuid: `msg-${i}`,
    type: "user",
    message: { role: "user", content: `line ${i}` },
    sessionId: "sess-offsets",
    timestamp: new Date().toISOString(),
  }) + "\n";

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "codememory-offsets-"));
  // ProjectWatcher derives its watch path from HOME. Restored in afterEach so
  // a leaked value cannot redirect another suite's paths.
  savedHome = process.env.HOME;
  process.env.HOME = root;
  projectDir = join(root, ".claude", "projects", "-tmp-proj");
  mkdirSync(projectDir, { recursive: true });
  transcript = join(projectDir, "sess-offsets.jsonl");
  writeFileSync(transcript, line(1) + line(2) + line(3));
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(root, { recursive: true, force: true });
});

async function runWatcher(
  store: WatcherOffsetStore | undefined,
  seedToEnd: boolean
): Promise<string[]> {
  const seen: string[] = [];
  const w = new ProjectWatcher(SILENT, {
    projectPath: "/tmp/proj",
    sessionId: "sess-offsets",
    pollInterval: 50,
    seedExistingFilesToEnd: seedToEnd,
    offsetStore: store,
    onMessage: (m) => {
      seen.push(m.id);
    },
  });
  await w.start();
  await new Promise((r) => setTimeout(r, 250));
  await w.stop();
  return seen;
}

describe("durable watcher offsets", () => {
  it("does not re-emit what a previous process already read", async () => {
    const store = makeStore();

    const first = await runWatcher(store, false);
    expect(first.length).toBe(3);

    const second = await runWatcher(store, false);
    expect(second).toEqual([]);
  });

  it("picks up what was appended while nothing was watching", async () => {
    const store = makeStore();
    await runWatcher(store, false);

    // The gap: written with no watcher running at all.
    appendFileSync(transcript, line(4) + line(5));

    const second = await runWatcher(store, false);
    // Exactly the gap, and only the gap.
    expect(second).toEqual(["msg-4", "msg-5"]);
  });

  it("is what seeding to the end throws away", async () => {
    // Same sequence without a store, which is the behavior being replaced.
    await runWatcher(undefined, true);
    appendFileSync(transcript, line(4) + line(5));
    const second = await runWatcher(undefined, true);
    expect(second).toEqual([]);
  });

  it("re-reads from the start when the file is shorter than its offset", async () => {
    const store = makeStore();
    await runWatcher(store, false);
    expect(store.rows.get(transcript)).toBeGreaterThan(0);

    // Truncated or rewritten: the stored offset no longer lands on a line
    // boundary, so reading from it would slice a record in half.
    writeFileSync(transcript, line(9));

    const second = await runWatcher(store, false);
    expect(second).toEqual(["msg-9"]);
  });

  it("lets a stored offset win over seeding to the end", async () => {
    const store = makeStore();
    await runWatcher(store, false);
    appendFileSync(transcript, line(4));

    // seedExistingFilesToEnd would normally write the file off as handled.
    const second = await runWatcher(store, true);
    expect(second).toEqual(["msg-4"]);
  });

  it("still seeds a file it has never seen before", async () => {
    const store = makeStore();
    // A transcript with no stored offset, with seeding on: the old behavior
    // applies, since there is no record of anything having read it.
    const other = join(projectDir, "sess-other.jsonl");
    writeFileSync(other, line(7));

    const seen = await runWatcher(store, true);
    expect(seen).toEqual([]);
  });

  it("behaves exactly as before when no store is supplied", async () => {
    const first = await runWatcher(undefined, false);
    expect(first.length).toBe(3);
    const second = await runWatcher(undefined, false);
    expect(second.length).toBe(3);
  });
});

describe("seeding covers subagent transcripts", () => {
  // Seeding listed only the top level of the project directory, while the
  // watcher also reads `<sessionId>/subagents/agent-*.jsonl`. The first
  // 0.6.0 daemon on a live session therefore read all six of its existing
  // subagent transcripts from byte 0: 46 rows, every one already stored by
  // the previous daemon. The source-uuid index could not refuse them because
  // the earlier copies predate the column and carry NULL.
  const subLine = (i: number) =>
    JSON.stringify({
      uuid: `sub-${i}`,
      type: "user",
      message: { role: "user", content: `subagent line ${i}` },
      sessionId: "sess-offsets",
      agentId: "a1",
      isSidechain: true,
      timestamp: new Date().toISOString(),
    }) + "\n";

  let subagentDir: string;
  beforeEach(() => {
    subagentDir = join(projectDir, "sess-offsets", "subagents");
    mkdirSync(subagentDir, { recursive: true });
  });

  it("does not replay a subagent transcript that was already on disk", async () => {
    writeFileSync(join(subagentDir, "agent-a1.jsonl"), subLine(1) + subLine(2));

    const seen = await runWatcher(makeStore(), true);
    expect(seen).toEqual([]);
  });

  it("still reads what a pre-existing subagent transcript gains afterwards", async () => {
    const file = join(subagentDir, "agent-a1.jsonl");
    writeFileSync(file, subLine(1));

    const seen: string[] = [];
    const w = new ProjectWatcher(SILENT, {
      projectPath: "/tmp/proj",
      sessionId: "sess-offsets",
      pollInterval: 50,
      seedExistingFilesToEnd: true,
      offsetStore: makeStore(),
      onMessage: (m) => {
        seen.push(m.id);
      },
    });
    await w.start();
    appendFileSync(file, subLine(2));
    await new Promise((r) => setTimeout(r, 250));
    await w.stop();

    // Seeding writes off the past, not the file.
    expect(seen).toEqual(["sub-2"]);
  });

  it("reads a subagent transcript created after start in full", async () => {
    const seen: string[] = [];
    const w = new ProjectWatcher(SILENT, {
      projectPath: "/tmp/proj",
      sessionId: "sess-offsets",
      pollInterval: 50,
      seedExistingFilesToEnd: true,
      offsetStore: makeStore(),
      onMessage: (m) => {
        seen.push(m.id);
      },
    });
    await w.start();
    writeFileSync(join(subagentDir, "agent-b2.jsonl"), subLine(1) + subLine(2));
    await new Promise((r) => setTimeout(r, 250));
    await w.stop();

    expect(seen).toEqual(["sub-1", "sub-2"]);
  });

  it("resumes a subagent transcript from its stored offset rather than seeding it", async () => {
    const file = join(subagentDir, "agent-a1.jsonl");
    writeFileSync(file, subLine(1));
    const store = makeStore();
    await runWatcher(store, false);

    appendFileSync(file, subLine(2));
    const seen = await runWatcher(store, true);
    expect(seen).toContain("sub-2");
    expect(seen).not.toContain("sub-1");
  });
});

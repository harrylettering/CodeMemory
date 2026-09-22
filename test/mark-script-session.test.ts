/**
 * A mark reaches the session that made it, or nothing.
 *
 * The mark skills ran `~/.claude/plugins/codememory/.../codememory-mark.sh`,
 * which exists only for a dev symlink; on a marketplace install the command
 * failed outright. Behind that was a worse problem. The script found its
 * socket from $CLAUDE_SESSION_ID -- never set in the environment the model's
 * Bash runs in -- and otherwise took the most recently modified live socket.
 * With eight sessions open that is usually another session's daemon, so a
 * decision would have been stored in, and recalled by, a session that never
 * made it: the cross-session leak #20 closed on the recall side, reopened on
 * the write side.
 *
 * The skills now pass the id Claude Code substitutes for ${CLAUDE_SESSION_ID},
 * and the script no longer guesses. Fail closed: a write that cannot be tied
 * to its session is dropped.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const REPO = path.resolve(__dirname, "..");
const SCRIPT = path.join(REPO, "hooks/scripts/codememory-mark.sh");

// Minimal daemon stand-in: answers any request on its socket and appends the
// request line to a log, so a test can see which session received the mark.
const STUB = `
const http = require("http"), fs = require("fs");
const [sock, log] = process.argv.slice(1); // node -e: args start at argv[1]
http.createServer((req, res) => {
  let body = ""; req.on("data", d => body += d);
  req.on("end", () => { fs.appendFileSync(log, req.url + " " + body + "\\n"); res.setHeader("content-type","application/json"); res.end('{"ok":true}'); });
}).listen(sock, () => process.send && process.send("ready"));
`;

let home: string;
let runtime: string;
let stubs: ChildProcess[] = [];

async function startDaemon(sid: string): Promise<string> {
  const log = path.join(home, `${sid}.log`);
  fs.writeFileSync(log, "");
  const child = spawn(process.execPath, ["-e", STUB, path.join(runtime, `${sid}.sock`), log], {
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  stubs.push(child);
  fs.writeFileSync(path.join(runtime, `${sid}.pid`), String(child.pid));
  await new Promise<void>((resolve) => child.once("message", () => resolve()));
  return log;
}

function mark(env: Record<string, string>): number {
  const clean: Record<string, string> = { ...process.env } as any;
  delete clean.CLAUDE_SESSION_ID;
  delete clean.CLAUDE_CODE_SESSION_ID;
  delete clean.CODEMEMORY_SOCKET;
  try {
    execFileSync("bash", [SCRIPT, "decision", '{"decision":"d","rationale":"r"}'], {
      env: { ...clean, HOME: home, ...env },
      stdio: "pipe",
    });
    return 0;
  } catch (error: any) {
    return error.status ?? 1;
  }
}

const received = (log: string) => fs.readFileSync(log, "utf8").trim();

beforeEach(() => {
  home = fs.mkdtempSync(path.join("/tmp", "cm-mark-"));
  runtime = path.join(home, ".claude", "codememory-runtime");
  fs.mkdirSync(runtime, { recursive: true });
  stubs = [];
});

afterEach(() => {
  for (const s of stubs) s.kill("SIGKILL");
  fs.rmSync(home, { recursive: true, force: true });
});

describe("codememory-mark.sh picks the calling session's daemon", () => {
  it("posts to the session named by CLAUDE_SESSION_ID, even when another socket is newer", async () => {
    const mine = await startDaemon("sess-mine");
    const other = await startDaemon("sess-other"); // started last: the newest socket

    expect(mark({ CLAUDE_SESSION_ID: "sess-mine" })).toBe(0);
    expect(received(mine)).toContain("/mark/decision");
    expect(received(other)).toBe("");
  });

  it("falls back to CLAUDE_CODE_SESSION_ID, which the Bash tool environment carries", async () => {
    const mine = await startDaemon("sess-mine");
    const other = await startDaemon("sess-other");

    expect(mark({ CLAUDE_CODE_SESSION_ID: "sess-mine" })).toBe(0);
    expect(received(mine)).toContain("/mark/decision");
    expect(received(other)).toBe("");
  });

  it("refuses rather than guessing when no session id is known", async () => {
    const other = await startDaemon("sess-other");

    expect(mark({})).not.toBe(0);
    expect(received(other)).toBe("");
  });

  it("refuses rather than guessing when its own daemon is not running", async () => {
    const other = await startDaemon("sess-other");

    expect(mark({ CLAUDE_SESSION_ID: "sess-mine" })).not.toBe(0);
    expect(received(other)).toBe("");
  });
});

describe("the mark skills", () => {
  const skills = ["codememory-mark-decision", "codememory-mark-task", "codememory-mark-constraint"];

  for (const skill of skills) {
    it(`${skill} runs the script from the plugin root with the session id`, () => {
      const body = fs.readFileSync(path.join(REPO, "skills", skill, "SKILL.md"), "utf8");
      // Only the dev symlink has this path; a marketplace install does not.
      expect(body).not.toContain("~/.claude/plugins/codememory");
      expect(body).toMatch(
        /CLAUDE_SESSION_ID=\$\{CLAUDE_SESSION_ID\} \$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/scripts\/codememory-mark\.sh (decision|requirement) /
      );
    });
  }
});

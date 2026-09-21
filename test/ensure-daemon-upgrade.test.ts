/**
 * ensure-daemon.sh must replace a daemon built from a different plugin
 * version, not just accept whatever answers on the socket.
 *
 * Before this, a live socket was enough. `/plugin` update plus
 * `/reload-plugins` keeps the session id, so the socket from the previous
 * version stayed live and every new hook talked to the old daemon. Measured
 * after the 0.6.0 install: 8 of 8 daemons still ran from the 0.5.0
 * directory, and the 99 rows written after the reload carried none of the
 * columns 0.6.0 added. The idle exit that would eventually retire them is
 * itself a 0.6.0 feature, so an old daemon never leaves on its own.
 *
 * The daemon here is a stub that speaks the same file protocol as the real
 * one -- pid file, socket, version file -- so the test exercises the script's
 * decisions and nothing else. Real paths live under /tmp: a unix socket path
 * over ~104 bytes fails to bind on macOS.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../hooks/scripts/ensure-daemon.sh");
const SID = "sess-upgrade";

const STUB = `
const fs = require("fs"), net = require("net"), path = require("path");
const [cmd, sid] = process.argv.slice(2);
const dir = path.join(process.env.HOME, ".claude", "codememory-runtime");
fs.mkdirSync(dir, { recursive: true });
const pidFile = path.join(dir, sid + ".pid");
const sock = path.join(dir, sid + ".sock");
const verFile = path.join(dir, sid + ".version");
if (cmd === "start") {
  fs.writeFileSync(pidFile, String(process.pid));
  const version = JSON.parse(fs.readFileSync(path.join(__dirname, "../../.claude-plugin/plugin.json"), "utf8")).version;
  const server = net.createServer().listen(sock, () => fs.writeFileSync(verFile, version));
  const bye = () => { try { fs.unlinkSync(sock); } catch {} try { fs.unlinkSync(pidFile); } catch {} process.exit(0); };
  process.on("SIGTERM", bye);
} else if (cmd === "stop") {
  if (!fs.existsSync(pidFile)) process.exit(0);
  const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
  try { process.kill(pid, "SIGTERM"); } catch {}
  const until = Date.now() + 3000;
  const wait = () => { if (!fs.existsSync(pidFile) || Date.now() > until) process.exit(0); setTimeout(wait, 50); };
  wait();
}
`;

let home: string;
let started: number[] = [];

function makePluginRoot(version: string): string {
  const root = fs.mkdtempSync(path.join(home, `plugin-${version}-`));
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({ name: "codememory-plugin", version })
  );
  fs.mkdirSync(path.join(root, "dist", "hooks"), { recursive: true });
  // The stub is CommonJS; the repo's package.json says "type": "module".
  fs.writeFileSync(path.join(root, "dist", "hooks", "daemon.js"), STUB);
  fs.writeFileSync(path.join(root, "dist", "hooks", "package.json"), '{"type":"commonjs"}');
  // The real hook scripts, so a test can go through the path a prompt takes
  // rather than calling ensure-daemon.sh directly.
  fs.cpSync(path.resolve(__dirname, "../hooks/scripts"), path.join(root, "hooks", "scripts"), {
    recursive: true,
  });
  return root;
}

function runtime(file: string): string {
  return path.join(home, ".claude", "codememory-runtime", file);
}

function ensure(pluginRoot: string): number {
  try {
    execFileSync("bash", [SCRIPT, SID, home, "3"], {
      env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
      stdio: "pipe",
    });
    return 0;
  } catch (error: any) {
    return error.status ?? 1;
  }
}

function daemonPid(): number {
  const pid = parseInt(fs.readFileSync(runtime(`${SID}.pid`), "utf8"), 10);
  started.push(pid);
  return pid;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join("/tmp", "cm-ens-"));
  started = [];
});

afterEach(() => {
  for (const pid of started) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      /* already gone */
    }
  }
  fs.rmSync(home, { recursive: true, force: true });
});

describe("ensure-daemon.sh across a plugin upgrade", () => {
  it("leaves a daemon of the same version alone", () => {
    const root = makePluginRoot("0.6.0");
    expect(ensure(root)).toBe(0);
    const first = daemonPid();

    expect(ensure(root)).toBe(0);
    expect(daemonPid()).toBe(first);
    expect(alive(first)).toBe(true);
  });

  it("replaces a daemon started from a different version", () => {
    const oldRoot = makePluginRoot("0.5.0");
    const newRoot = makePluginRoot("0.6.0");
    expect(ensure(oldRoot)).toBe(0);
    const oldPid = daemonPid();

    expect(ensure(newRoot)).toBe(0);
    const newPid = daemonPid();

    expect(newPid).not.toBe(oldPid);
    expect(alive(oldPid)).toBe(false);
    expect(fs.readFileSync(runtime(`${SID}.version`), "utf8")).toBe("0.6.0");
  });

  it("replaces a daemon that predates version files entirely", () => {
    // Every 0.5.0 daemon on a real machine is in this state: it never wrote
    // a version file, so there is nothing to compare. Absence has to count
    // as a mismatch, or the daemons this fix exists for are the ones it
    // skips.
    const root = makePluginRoot("0.6.0");
    expect(ensure(root)).toBe(0);
    const oldPid = daemonPid();
    fs.unlinkSync(runtime(`${SID}.version`));

    expect(ensure(root)).toBe(0);
    const newPid = daemonPid();

    expect(newPid).not.toBe(oldPid);
    expect(alive(oldPid)).toBe(false);
  });

  it("keeps the daemon when the plugin's own version cannot be read", () => {
    // Replacing on an unreadable manifest would restart the daemon on every
    // prompt. Failing toward the running daemon is the cheap direction.
    const root = makePluginRoot("0.6.0");
    expect(ensure(root)).toBe(0);
    const first = daemonPid();
    fs.rmSync(path.join(root, ".claude-plugin", "plugin.json"));

    expect(ensure(root)).toBe(0);
    expect(daemonPid()).toBe(first);
  });
});

describe("the prompt hook across a plugin upgrade", () => {
  // ensure-daemon.sh checked the version, but user-prompt-submit.sh only
  // called it when the socket was missing -- and after /reload-plugins the
  // old socket is live. The check never ran on the path an upgrade takes:
  // after installing 0.6.1 and sending a prompt, this session's daemon was
  // still the 0.6.0 one. Testing the script alone could not see that.
  function prompt(pluginRoot: string): void {
    execFileSync("bash", [path.join(pluginRoot, "hooks", "scripts", "user-prompt-submit.sh")], {
      env: { ...process.env, HOME: home, CLAUDE_PLUGIN_ROOT: pluginRoot },
      input: JSON.stringify({ session_id: SID, prompt: "hello", cwd: home }),
      stdio: "pipe",
    });
  }

  it("replaces an old daemon whose socket is still live", () => {
    const oldRoot = makePluginRoot("0.5.0");
    const newRoot = makePluginRoot("0.6.1");
    expect(ensure(oldRoot)).toBe(0);
    const oldPid = daemonPid();
    expect(fs.existsSync(runtime(`${SID}.sock`))).toBe(true);

    prompt(newRoot);

    const newPid = daemonPid();
    expect(newPid).not.toBe(oldPid);
    expect(alive(oldPid)).toBe(false);
    expect(fs.readFileSync(runtime(`${SID}.version`), "utf8")).toBe("0.6.1");
  });

  it("keeps a current daemon across prompts", () => {
    const root = makePluginRoot("0.6.1");
    expect(ensure(root)).toBe(0);
    const pid = daemonPid();

    prompt(root);
    prompt(root);

    expect(daemonPid()).toBe(pid);
    expect(alive(pid)).toBe(true);
  });
});

describe("the version the daemon records", () => {
  it("is read from the same manifest the script compares against", async () => {
    const { readPluginVersion, pluginRootFromHooksDir } = await import(
      "../src/hooks/daemon-version.js"
    );
    // The compiled daemon lives in <root>/dist/hooks; resolving from there
    // must land on this repo's root, or the two sides read different files
    // and every prompt replaces the daemon.
    const repoRoot = path.resolve(__dirname, "..");
    const root = pluginRootFromHooksDir(path.join(repoRoot, "dist", "hooks"));
    expect(root).toBe(repoRoot);

    const manifest = JSON.parse(
      fs.readFileSync(path.join(repoRoot, ".claude-plugin", "plugin.json"), "utf8")
    );
    expect(readPluginVersion(root)).toBe(manifest.version);
  });

  it("is null when there is no manifest to read", async () => {
    const { readPluginVersion } = await import("../src/hooks/daemon-version.js");
    expect(readPluginVersion(home)).toBeNull();
  });
});

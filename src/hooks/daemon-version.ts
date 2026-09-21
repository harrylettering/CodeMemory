/**
 * The plugin version a daemon was built from, as ensure-daemon.sh reads it.
 *
 * The daemon records this next to its socket so the hook script can tell a
 * daemon from an older install apart from one it should keep. Both sides read
 * the same manifest, `.claude-plugin/plugin.json` under the plugin root: the
 * script via $CLAUDE_PLUGIN_ROOT, the daemon relative to its own dist/ file.
 */
import fs from "node:fs";
import path from "node:path";

export function readPluginVersion(pluginRoot: string): string | null {
  try {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(pluginRoot, ".claude-plugin", "plugin.json"), "utf-8")
    );
    return typeof manifest.version === "string" && manifest.version
      ? manifest.version
      : null;
  } catch {
    return null;
  }
}

/** Plugin root for a module compiled to `<root>/dist/hooks/`. */
export function pluginRootFromHooksDir(hooksDir: string): string {
  return path.resolve(hooksDir, "..", "..");
}

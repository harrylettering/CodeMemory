/**
 * Fails the release check when the freshly built `dist/` differs from what is
 * committed.
 *
 * Marketplace installs run the `dist/*.js` files stored in Git, not a build
 * performed on the user's machine. That makes a stale `dist/` invisible to
 * every local check: the build succeeds, the tests pass against `src/`, the
 * plugin validates — and the release still ships the previous compiler output.
 *
 * This is not hypothetical. The node:sqlite migration landed in `src/` and
 * merged to `main` while `dist/db/connection.js` still carried
 * `import sqlite3 from "sqlite3"`, so installs kept failing on a dependency the
 * package no longer declared. Run this after `npm run build`, before tagging.
 *
 * Note the deliberate use of `git status --porcelain` rather than `git diff`:
 * a newly added output file (a new module compiled for the first time) is
 * untracked, and `git diff` does not report untracked paths.
 */

import { execFileSync } from "node:child_process";

const DIST = "dist";

function git(args) {
  return execFileSync("git", args, { encoding: "utf-8" });
}

let status;
try {
  // Only trailing whitespace may be stripped. The first character of a
  // porcelain line carries meaning — an unstaged modification is " M", so a
  // plain .trim() eats the leading space of the first entry and corrupts it.
  status = git(["status", "--porcelain", "--", DIST]).replace(/\s+$/, "");
} catch (error) {
  console.error(
    `[release-check] could not inspect ${DIST}/ with git: ${error.message}`
  );
  process.exit(1);
}

if (!status) {
  console.log(`[release-check] ${DIST}/ matches the committed build.`);
  process.exit(0);
}

// Porcelain lines are `XY <path>`, but X and Y each may be a space depending on
// whether the change is staged, so the path cannot be taken at a fixed offset.
const entries = status
  .split("\n")
  .map((line) => {
    const match = /^(.)(.)\s+(.*)$/.exec(line);
    if (!match) return `  ${line}`;
    const [, staged, worktree, path] = match;
    const label =
      staged === "?" ? "untracked" : staged === "D" || worktree === "D" ? "deleted" : "modified";
    return `  ${label.padEnd(9)} ${path}`;
  })
  .join("\n");

console.error(
  `[release-check] ${DIST}/ does not match the committed build:\n\n` +
    entries +
    `\n\nMarketplace installs run the committed dist/, so releasing now would ` +
    `ship the previous compiler output.\nCommit these files together with the ` +
    `source changes that produced them, then re-run the release check.\n`
);
process.exit(1);

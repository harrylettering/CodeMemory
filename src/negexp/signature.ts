/**
 * Error signature normalization — conservative approach.
 *
 * Only strips absolute paths and line numbers. Rationale:
 * - Path/line changes between runs are the most common source of "same error,
 *   different signature" mismatches.
 * - Variables/function names should stay: different variables often mean
 *   different bugs.
 */

// Matchers to strip. Greedy + at-least-one-segment so we don't degenerate
// to matching a bare "/". Each segment can contain anything except whitespace
// and colons (colons separate path from line/col in stack traces).
const ABSOLUTE_PATH_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  // macOS/Linux absolute paths: /foo, /foo/bar/baz.ts, /a/b/c/d.py
  { re: /\/(?:[^\s:/]+\/)*[^\s:/]+/g, replace: "<path>" },
  // Windows absolute paths: C:\foo\bar.ts
  { re: /[a-zA-Z]:\\(?:[^\s:\\]+\\)*[^\s:\\]+/g, replace: "<path>" },
];

const LINE_NUMBER_PATTERNS: Array<{ re: RegExp; replace: string }> = [
  { re: /\bline\s+\d+(\b|,)/gi, replace: "" },
  { re: /\bat\s+<path>:\d+/g, replace: " at <path>" },
  { re: /:\d+(?=:|$)/g, replace: "" }, // standalone :123 suffixes
];

export interface NormalizationOptions {
  aggressive?: boolean;
}

/**
 * Lines that carry the failure itself, as opposed to whatever the command
 * printed around it.
 *
 * Deliberately narrower than the scorer's detection patterns: those decide
 * *whether* output contains a failure, which can afford to be generous. This
 * decides *which line is the failure*, and a generous match here pollutes the
 * signature that the whole anchor-matching scheme depends on.
 */
const SIGNATURE_LINE_PATTERNS: RegExp[] = [
  /\bTS\d{4}\b/,
  /\b(SyntaxError|TypeError|ReferenceError|NameError|AttributeError|KeyError|ValueError|IndexError|RuntimeError|FileNotFoundError|PermissionError|ModuleNotFoundError|ImportError|ZeroDivisionError)\b/,
  /\berror\b[:\s]/i,
  /\bfatal\b[:\s]/i,
  /Cannot find module/i,
  /Cannot read propert/i,
  /is not a function/,
  /is not defined/,
  /\b(ENOENT|EACCES|EPERM|ECONNREFUSED|ETIMEDOUT|EADDRINUSE)\b/,
  /^npm ERR!/m,
  /^panic:/m,
  /Traceback \(most recent call last\)/,
  /^\s*at .+\(.+:\d+:\d+\)/m,
  /command not found/i,
  /no such file or directory/i,
  /permission denied/i,
];

/** Says a command failed, not how — usable only alongside something else. */
const EXIT_CODE_PATTERN = /\bexit code\s+[^0]/i;

/** A signature past this length has stopped being a fingerprint. */
const MAX_SIGNATURE_CHARS = 200;

/**
 * Reduce a raw tool result to the lines that actually describe the failure.
 *
 * Without this, `normalizeError` fingerprints the entire output — a `cd &&
 * tsc` whose result also contained a directory listing produced a 300-plus
 * character signature beginning with `total 16 drwxr-xr-x@ ...`. Two runs of
 * the same failure never produce identical surrounding output, so such a
 * signature can never match a second occurrence, and signature-anchored recall
 * silently degrades to nothing. Measured on a real database: median signature
 * length 330 characters, only 32% short enough to be reusable.
 *
 * Falls back to the head of the input when nothing matches, so an unrecognized
 * failure still yields something bounded rather than the whole payload.
 */
export function extractErrorLines(raw: string, maxLines = 3): string {
  const lines = raw.split("\n").filter((l) => l.trim());

  const matched: string[] = [];
  for (const line of lines) {
    if (SIGNATURE_LINE_PATTERNS.some((re) => re.test(line))) {
      matched.push(line.trim());
      if (matched.length >= maxLines) break;
    }
  }

  if (matched.length > 0) return matched.join(" ");

  // Nothing recognizable. `Exit code 1` says a command failed and nothing
  // about how, so building a signature out of it plus whatever happened to
  // print nearby collapses unrelated failures onto one key — measured on a
  // real database, three different failures shared a signature that way.
  //
  // That is worse than an over-long signature. Over-long fails to match;
  // identical matches the wrong thing, and a false prior-failure warning
  // costs more trust than a missing one. Return the head, bounded, and let
  // the caller decide whether it is worth anchoring on.
  return lines.slice(0, maxLines).join(" ");
}

/**
 * Whether a signature is specific enough to anchor recall on.
 *
 * A signature is an equality key. One built only from "a command exited
 * non-zero" matches every other command that exited non-zero, so it must not
 * be indexed even though the failure itself is still worth storing.
 */
export function isAnchorableSignature(signature: string): boolean {
  // Strip what the harness contributes before judging what is left. The
  // `[tool_result]` prefix is added by the watcher when flattening parts, so
  // `[tool_result] Exit code 1` looked like 25 characters of signal and is
  // really none: every failed command produces exactly that string.
  const residual = signature
    .replace(/^\s*\[tool_result\]\s*/i, "")
    .replace(EXIT_CODE_PATTERN, "")
    .replace(/[\s\-=]+/g, " ")
    .trim();
  return residual.length >= 12;
}

export function normalizeError(raw: string, opts: NormalizationOptions = {}): string {
  // Isolate the failure before normalizing it. Everything downstream treats
  // the result as a fingerprint to match against future failures, and text
  // that merely surrounded the error this one time defeats that.
  let normalized = extractErrorLines(raw).trim();

  // 1. Strip absolute paths
  for (const pat of ABSOLUTE_PATH_PATTERNS) {
    normalized = normalized.replace(pat.re, pat.replace);
  }

  // 2. Strip line numbers
  for (const pat of LINE_NUMBER_PATTERNS) {
    normalized = normalized.replace(pat.re, pat.replace);
  }

  // 3. Strip trailing punctuation
  normalized = normalized.replace(/[,:;.]$/, "");

  // 4. Fold whitespace
  normalized = normalized.replace(/\s+/g, " ");

  // 5. Cap. A signature is an equality key; past a couple of hundred
  // characters it is carrying incidental detail that will differ next time.
  if (normalized.length > MAX_SIGNATURE_CHARS) {
    normalized = normalized.slice(0, MAX_SIGNATURE_CHARS);
  }

  return normalized;
}

/**
 * Best-effort symbol extraction from a raw error message. We try several
 * language-specific patterns in order of strength and return the first
 * confident hit. Returns undefined if nothing recognisable shows up.
 *
 * Coverage:
 *   - Python Traceback:        `File "x.py", line 10, in <funcname>`
 *   - Python AttributeError:   `'X' object has no attribute 'y'` → `y`
 *   - Python NameError:        `name 'foo' is not defined`        → `foo`
 *   - JS/TS stack trace:       `at funcName (file:line:col)`      → `funcName`
 *   - JS ReferenceError:       `foo is not defined`               → `foo`
 *   - JS TypeError:            `Cannot read properties of undefined (reading 'bar')` → `bar`
 *   - Go panic:                `funcName(...)` after the panic line → `funcName`
 *   - Rust panic:              `thread 'main' panicked at ...`     → "main"
 *   - TS diagnostics:          `Property 'foo' does not exist`     → `foo`
 *
 * The output is intentionally conservative — false positives here would
 * pollute symbol-keyed retrieval. We only return identifiers, no spaces.
 */
export function extractSymbol(raw: string): string | undefined {
  if (!raw) return undefined;

  const tryRe = (re: RegExp): string | undefined => {
    const m = raw.match(re);
    if (!m) return undefined;
    const sym = (m[1] || "").trim();
    // Reject anything with whitespace, parens, brackets — we want bare
    // identifiers (or qualified ones like Foo.bar).
    if (!sym || /[\s()\[\]{}<>'"`]/.test(sym)) return undefined;
    if (sym.length > 80) return undefined;
    return sym;
  };

  // Python Traceback: prefer the deepest frame's function name. Match all
  // and take the LAST one (deepest stack frame is the actual failure).
  const pyFrames = [...raw.matchAll(/in\s+([A-Za-z_][\w.]*)\s*$/gm)];
  if (pyFrames.length > 0) {
    const deepest = pyFrames[pyFrames.length - 1][1];
    if (deepest && deepest !== "<module>") return deepest;
  }

  // Python AttributeError: 'Foo' object has no attribute 'bar'
  const pyAttr = tryRe(/has no attribute ['"]([\w.]+)['"]/);
  if (pyAttr) return pyAttr;

  // Python NameError: name 'foo' is not defined
  const pyName = tryRe(/name ['"]([\w.]+)['"]\s+is not defined/);
  if (pyName) return pyName;

  // JS/TS V8 stack frame: "    at funcName (file:line:col)"
  // Take the first non-anonymous frame. Skip "Object.<anonymous>", arrow
  // function placeholders, and node-internal frames.
  const jsFrames = [...raw.matchAll(/^\s*at\s+([\w$.<>]+)\s*\(/gm)];
  for (const f of jsFrames) {
    const name = f[1];
    if (
      name &&
      !name.startsWith("Object.<") &&
      !name.startsWith("Module.") &&
      !name.includes("node:") &&
      !/^anonymous$/i.test(name)
    ) {
      // Strip trailing dots / leading dots that creep in from wonky stacks.
      const cleaned = name.replace(/^\.+|\.+$/g, "");
      if (cleaned && !/[\s()'"`]/.test(cleaned)) return cleaned;
    }
  }

  // JS ReferenceError: foo is not defined
  const jsRef = tryRe(/ReferenceError:\s+([\w$]+)\s+is not defined/);
  if (jsRef) return jsRef;

  // JS TypeError: Cannot read properties of undefined (reading 'bar')
  const jsRead = tryRe(/Cannot read propert(?:y|ies) of \w+ \(reading ['"]([\w$]+)['"]\)/);
  if (jsRead) return jsRead;

  // Older form: Cannot read property 'bar' of undefined
  const jsReadOld = tryRe(/Cannot read property ['"]([\w$]+)['"] of/);
  if (jsReadOld) return jsReadOld;

  // TS diagnostics: Property 'foo' does not exist on type 'X'
  const tsProp = tryRe(/Property ['"]([\w$]+)['"] does not exist/);
  if (tsProp) return tsProp;

  // Go panic with explicit function: "github.com/x/pkg.FuncName(...)"
  const goFunc = tryRe(/\b([\w./]+\.[A-Z]\w*)\(/);
  if (goFunc && goFunc.includes(".")) {
    // Take the last segment after the final dot.
    const last = goFunc.split(".").pop();
    if (last && /^[A-Z]\w*$/.test(last)) return last;
  }

  // Rust: "thread 'name' panicked"
  const rustThread = tryRe(/thread ['"]([\w-]+)['"] panicked/);
  if (rustThread && rustThread !== "main") return rustThread;

  return undefined;
}

/**
 * Simple classifier to help group errors. For Phase 2, just a few broad
 * categories.
 */
export function classifyError(normalized: string): string {
  if (/index.*out\s+of.*range|out of bounds/i.test(normalized)) {
    return "index_error";
  }
  if (/reference.*undefined|cannot read.*undefined|cannot access/i.test(normalized)) {
    return "undefined_error";
  }
  if (/type.*mismatch|ts\d{4}/i.test(normalized)) {
    return "type_error";
  }
  if (/syntax.*error|unexpected token/i.test(normalized)) {
    return "syntax_error";
  }
  if (/enoent|no such file|file not found/i.test(normalized)) {
    return "file_not_found";
  }
  if (/permission.*denied|eperm/i.test(normalized)) {
    return "permission_error";
  }
  if (/exit code\s+[^0]/i.test(normalized)) {
    return "exit_error";
  }
  return "other";
}

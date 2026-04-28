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
const ABSOLUTE_PATH_PATTERNS = [
    // macOS/Linux absolute paths: /foo, /foo/bar/baz.ts, /a/b/c/d.py
    { re: /\/(?:[^\s:/]+\/)*[^\s:/]+/g, replace: "<path>" },
    // Windows absolute paths: C:\foo\bar.ts
    { re: /[a-zA-Z]:\\(?:[^\s:\\]+\\)*[^\s:\\]+/g, replace: "<path>" },
];
const LINE_NUMBER_PATTERNS = [
    { re: /\bline\s+\d+(\b|,)/gi, replace: "" },
    { re: /\bat\s+<path>:\d+/g, replace: " at <path>" },
    { re: /:\d+(?=:|$)/g, replace: "" }, // standalone :123 suffixes
];
export function normalizeError(raw, opts = {}) {
    let normalized = raw.trim();
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
export function extractSymbol(raw) {
    if (!raw)
        return undefined;
    const tryRe = (re) => {
        const m = raw.match(re);
        if (!m)
            return undefined;
        const sym = (m[1] || "").trim();
        // Reject anything with whitespace, parens, brackets — we want bare
        // identifiers (or qualified ones like Foo.bar).
        if (!sym || /[\s()\[\]{}<>'"`]/.test(sym))
            return undefined;
        if (sym.length > 80)
            return undefined;
        return sym;
    };
    // Python Traceback: prefer the deepest frame's function name. Match all
    // and take the LAST one (deepest stack frame is the actual failure).
    const pyFrames = [...raw.matchAll(/in\s+([A-Za-z_][\w.]*)\s*$/gm)];
    if (pyFrames.length > 0) {
        const deepest = pyFrames[pyFrames.length - 1][1];
        if (deepest && deepest !== "<module>")
            return deepest;
    }
    // Python AttributeError: 'Foo' object has no attribute 'bar'
    const pyAttr = tryRe(/has no attribute ['"]([\w.]+)['"]/);
    if (pyAttr)
        return pyAttr;
    // Python NameError: name 'foo' is not defined
    const pyName = tryRe(/name ['"]([\w.]+)['"]\s+is not defined/);
    if (pyName)
        return pyName;
    // JS/TS V8 stack frame: "    at funcName (file:line:col)"
    // Take the first non-anonymous frame. Skip "Object.<anonymous>", arrow
    // function placeholders, and node-internal frames.
    const jsFrames = [...raw.matchAll(/^\s*at\s+([\w$.<>]+)\s*\(/gm)];
    for (const f of jsFrames) {
        const name = f[1];
        if (name &&
            !name.startsWith("Object.<") &&
            !name.startsWith("Module.") &&
            !name.includes("node:") &&
            !/^anonymous$/i.test(name)) {
            // Strip trailing dots / leading dots that creep in from wonky stacks.
            const cleaned = name.replace(/^\.+|\.+$/g, "");
            if (cleaned && !/[\s()'"`]/.test(cleaned))
                return cleaned;
        }
    }
    // JS ReferenceError: foo is not defined
    const jsRef = tryRe(/ReferenceError:\s+([\w$]+)\s+is not defined/);
    if (jsRef)
        return jsRef;
    // JS TypeError: Cannot read properties of undefined (reading 'bar')
    const jsRead = tryRe(/Cannot read propert(?:y|ies) of \w+ \(reading ['"]([\w$]+)['"]\)/);
    if (jsRead)
        return jsRead;
    // Older form: Cannot read property 'bar' of undefined
    const jsReadOld = tryRe(/Cannot read property ['"]([\w$]+)['"] of/);
    if (jsReadOld)
        return jsReadOld;
    // TS diagnostics: Property 'foo' does not exist on type 'X'
    const tsProp = tryRe(/Property ['"]([\w$]+)['"] does not exist/);
    if (tsProp)
        return tsProp;
    // Go panic with explicit function: "github.com/x/pkg.FuncName(...)"
    const goFunc = tryRe(/\b([\w./]+\.[A-Z]\w*)\(/);
    if (goFunc && goFunc.includes(".")) {
        // Take the last segment after the final dot.
        const last = goFunc.split(".").pop();
        if (last && /^[A-Z]\w*$/.test(last))
            return last;
    }
    // Rust: "thread 'name' panicked"
    const rustThread = tryRe(/thread ['"]([\w-]+)['"] panicked/);
    if (rustThread && rustThread !== "main")
        return rustThread;
    return undefined;
}
/**
 * Simple classifier to help group errors. For Phase 2, just a few broad
 * categories.
 */
export function classifyError(normalized) {
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
//# sourceMappingURL=signature.js.map
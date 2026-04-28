/**
 * CodeMemory for Claude Code - Tool Utilities
 *
 * Common utilities used by CodeMemory tools.
 */
/** Render structured payloads as deterministic text tool results. */
export function jsonResult(payload) {
    return {
        content: [
            {
                type: "text",
                text: JSON.stringify(payload, null, 2),
            },
        ],
        details: payload,
    };
}
/** Read a string param with optional trimming/required checks. */
export function readStringParam(params, key, options) {
    const raw = params[key];
    if (raw == null) {
        if (options?.required) {
            throw new Error(`${options.label ?? key} is required.`);
        }
        return undefined;
    }
    if (typeof raw !== "string") {
        throw new Error(`${options?.label ?? key} must be a string.`);
    }
    const value = options?.trim === false ? raw : raw.trim();
    if (!options?.allowEmpty && value.length === 0) {
        if (options?.required) {
            throw new Error(`${options.label ?? key} is required.`);
        }
        return undefined;
    }
    return value;
}
/** Read an optional array param with validation. */
export function readStringArrayParam(params, key, options) {
    const raw = params[key];
    if (raw == null) {
        if (options?.required) {
            throw new Error(`${options.label ?? key} is required.`);
        }
        return [];
    }
    if (!Array.isArray(raw)) {
        throw new Error(`${options?.label ?? key} must be an array`);
    }
    return raw
        .filter((value) => typeof value === "string")
        .map(value => options?.trim === false ? value : value.trim())
        .filter(value => {
        if (options?.allowEmpty) {
            return true;
        }
        return value.length > 0;
    });
}
/** Read a numeric param with range validation. */
export function readNumberParam(params, key, options) {
    const raw = params[key];
    if (raw == null) {
        if (options?.required) {
            throw new Error(`${options?.label ?? key} is required.`);
        }
        return undefined;
    }
    const num = typeof raw === "string" ? parseFloat(raw) : Number(raw);
    if (Number.isNaN(num)) {
        throw new Error(`${options?.label ?? key} must be a number`);
    }
    if (typeof options?.minimum === "number" && num < options.minimum) {
        throw new Error(`${options?.label ?? key} must be at least ${options.minimum}`);
    }
    if (typeof options?.maximum === "number" && num > options.maximum) {
        throw new Error(`${options?.label ?? key} must be at most ${options.maximum}`);
    }
    return num;
}
/** Read a boolean param. */
export function readBooleanParam(params, key, options) {
    const raw = params[key];
    if (raw == null) {
        if (options?.required) {
            throw new Error(`${options?.label ?? key} is required.`);
        }
        return undefined;
    }
    if (typeof raw === "boolean") {
        return raw;
    }
    if (typeof raw === "string") {
        const normalized = raw.toLowerCase().trim();
        return normalized === "true" || normalized === "1" || normalized === "yes";
    }
    if (typeof raw === "number") {
        return raw !== 0;
    }
    return !!raw;
}
//# sourceMappingURL=common.js.map
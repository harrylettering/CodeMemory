import { spawn } from "node:child_process";
import { createFastRetrievalPlan, normalizeTagValue, } from "./retrieval-plan.js";
export class SmartQueryPlanner {
    config;
    runCompletion;
    constructor(config, runCompletion = (prompt) => runClaudePlanner(prompt, this.config)) {
        this.config = config;
        this.runCompletion = runCompletion;
    }
    async plan(input) {
        const output = await this.runCompletion(buildPlannerPrompt(input));
        const parsed = parsePlannerJson(output);
        return coercePlannerOutput(parsed, input.fastPlan);
    }
}
export function decideSmartPlanning(input) {
    if (!input.enabled) {
        return { shouldPlan: false, reason: "disabled" };
    }
    const hasStrongAnchor = input.fastPlan.entities.files.length > 0 ||
        input.fastPlan.entities.commands.length > 0 ||
        input.fastPlan.entities.symbols.length > 0;
    const bestScore = input.memoryNodes[0]?.score ?? 0;
    const weakRetrieval = input.memoryNodes.length === 0 || bestScore < input.fastPlan.recallPolicy.minScore + 0.25;
    const asksHistory = /之前|当时|历史|决策|决定|为什么|踩坑|失败过|冲突|原因|rationale|decision|decided|history|previous|prior/i.test(input.prompt);
    const abstractPrompt = !hasStrongAnchor && input.fastPlan.entities.topics.length > 0;
    if (weakRetrieval && asksHistory) {
        return {
            shouldPlan: true,
            reason: input.memoryNodes.length === 0 ? "no_fast_memory_hits" : "weak_fast_memory_hits",
        };
    }
    if (weakRetrieval && abstractPrompt) {
        return { shouldPlan: true, reason: "abstract_prompt_without_strong_anchor" };
    }
    return { shouldPlan: false, reason: "fast_plan_sufficient" };
}
export function createSmartQueryPlanner(config) {
    return new SmartQueryPlanner(config);
}
function buildPlannerPrompt(input) {
    return [
        "You are a query planner for a coding-agent memory system.",
        "You are not answering the user. Convert the user prompt into RetrievalPlan JSON only.",
        "Do not invent historical facts. Only extract and expand query anchors that can help retrieve memory.",
        "Return JSON with these fields: intent, riskLevel, entities, wantedKinds, queryVariants, tagQueries, recallPolicy.",
        "Allowed intents: modify_and_avoid_prior_failure, recall_decision_rationale, debug_prior_failure, general_context_lookup.",
        "Allowed wantedKinds: task, constraint, failure, decision, fix_attempt, summary_anchor, rationale.",
        "Use tagQueries with tagType values such as file, command, symbol, package, topic, kind.",
        "Keep maxCandidates <= 40, maxInjectedItems <= 8, tokenBudget <= 1600.",
        "",
        `Planner trigger reason: ${input.reason}`,
        "",
        "User prompt:",
        input.prompt.slice(0, 4000),
        "",
        "Fast plan JSON:",
        JSON.stringify(input.fastPlan),
    ].join("\n");
}
function parsePlannerJson(output) {
    const trimmed = (output || "").trim();
    if (!trimmed)
        throw new Error("empty planner output");
    try {
        return JSON.parse(trimmed);
    }
    catch {
        const start = trimmed.indexOf("{");
        const end = trimmed.lastIndexOf("}");
        if (start < 0 || end <= start) {
            throw new Error("planner output did not contain JSON object");
        }
        return JSON.parse(trimmed.slice(start, end + 1));
    }
}
function coercePlannerOutput(raw, fastPlan) {
    if (!raw || typeof raw !== "object") {
        throw new Error("planner JSON is not an object");
    }
    const entities = {
        files: stringArray(raw.entities?.files).slice(0, 8),
        commands: stringArray(raw.entities?.commands).slice(0, 6),
        symbols: stringArray(raw.entities?.symbols).slice(0, 10),
        packages: stringArray(raw.entities?.packages).slice(0, 6),
        topics: stringArray(raw.entities?.topics).slice(0, 10),
    };
    const wantedKinds = normalizeWantedKinds(raw.wantedKinds, fastPlan.wantedKinds);
    const tagQueries = normalizeTagQueries(raw.tagQueries, wantedKinds);
    const queryVariants = stringArray(raw.queryVariants).slice(0, 8);
    const plan = {
        ...fastPlan,
        intent: normalizeIntent(raw.intent, fastPlan.intent),
        riskLevel: normalizeRisk(raw.riskLevel, fastPlan.riskLevel),
        entities: {
            files: mergeStrings(fastPlan.entities.files, entities.files).slice(0, 8),
            commands: mergeStrings(fastPlan.entities.commands, entities.commands).slice(0, 6),
            symbols: mergeStrings(fastPlan.entities.symbols, entities.symbols).slice(0, 10),
            packages: mergeStrings(fastPlan.entities.packages, entities.packages).slice(0, 6),
            topics: mergeStrings(fastPlan.entities.topics, entities.topics).slice(0, 10),
        },
        wantedKinds,
        queryVariants: mergeStrings(fastPlan.queryVariants, queryVariants).slice(0, 8),
        tagQueries: mergeTagQueries(fastPlan.tagQueries, tagQueries).slice(0, 20),
        recallPolicy: {
            maxCandidates: clampNumber(raw.recallPolicy?.maxCandidates, fastPlan.recallPolicy.maxCandidates, 1, 40),
            maxInjectedItems: clampNumber(raw.recallPolicy?.maxInjectedItems, fastPlan.recallPolicy.maxInjectedItems, 1, 8),
            tokenBudget: clampNumber(raw.recallPolicy?.tokenBudget, fastPlan.recallPolicy.tokenBudget, 200, 1600),
            expandSummaries: typeof raw.recallPolicy?.expandSummaries === "boolean"
                ? raw.recallPolicy.expandSummaries
                : fastPlan.recallPolicy.expandSummaries,
            maxSummaryDepth: clampNumber(raw.recallPolicy?.maxSummaryDepth, fastPlan.recallPolicy.maxSummaryDepth, 0, 2),
            minScore: clampNumber(raw.recallPolicy?.minScore, fastPlan.recallPolicy.minScore, 0.1, 2.5),
        },
    };
    if (plan.tagQueries.length === 0) {
        return createFastRetrievalPlan(fastPlan.rawPrompt);
    }
    return plan;
}
function normalizeIntent(value, fallback) {
    const allowed = [
        "modify_and_avoid_prior_failure",
        "recall_decision_rationale",
        "debug_prior_failure",
        "general_context_lookup",
    ];
    return allowed.includes(value) ? value : fallback;
}
function normalizeRisk(value, fallback) {
    return value === "low" || value === "medium" || value === "high" ? value : fallback;
}
function normalizeWantedKinds(value, fallback) {
    const allowed = new Set([
        "task",
        "constraint",
        "failure",
        "decision",
        "fix_attempt",
        "summary_anchor",
        "summary",
    ]);
    const raw = Array.isArray(value)
        ? value.map((item) => (typeof item === "string" ? item : item?.kind))
        : [];
    const kinds = raw.filter((kind) => allowed.has(kind));
    return mergeStrings(fallback, kinds);
}
function normalizeTagQueries(raw, wantedKinds) {
    const tags = [];
    if (Array.isArray(raw)) {
        for (const item of raw) {
            const tagType = typeof item?.tagType === "string" ? item.tagType : undefined;
            const tagValue = typeof item?.tagValue === "string" ? item.tagValue : undefined;
            if (!tagType || !tagValue)
                continue;
            tags.push({
                tagType,
                tagValue,
                weight: clampNumber(item?.weight, 1, 0.1, 3),
            });
        }
    }
    for (const kind of wantedKinds) {
        tags.push({ tagType: "kind", tagValue: kind, weight: 0.8 });
    }
    return tags;
}
function mergeStrings(...groups) {
    const seen = new Set();
    const result = [];
    for (const group of groups) {
        for (const item of group) {
            const value = String(item || "").trim();
            if (!value)
                continue;
            const key = normalizeTagValue(value);
            if (seen.has(key))
                continue;
            seen.add(key);
            result.push(value);
        }
    }
    return result;
}
function mergeTagQueries(...groups) {
    const merged = new Map();
    for (const group of groups) {
        for (const tag of group) {
            const tagValue = String(tag.tagValue || "").trim();
            if (!tag.tagType || !tagValue)
                continue;
            const key = `${tag.tagType}:${normalizeTagValue(tagValue)}`;
            const existing = merged.get(key);
            if (!existing || tag.weight > existing.weight) {
                merged.set(key, { ...tag, tagValue });
            }
        }
    }
    return Array.from(merged.values());
}
function stringArray(value) {
    if (!Array.isArray(value))
        return [];
    return value
        .map((item) => (typeof item === "string" ? item : item?.raw ?? item?.text ?? ""))
        .filter((item) => typeof item === "string" && item.trim().length > 0);
}
function clampNumber(value, fallback, min, max) {
    const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
    return Math.max(min, Math.min(max, n));
}
function runClaudePlanner(prompt, config) {
    return new Promise((resolve, reject) => {
        const args = ["--bare", "--print", "--output-format", "text"];
        if (config.queryPlannerModel) {
            args.push("--model", config.queryPlannerModel);
        }
        const child = spawn("claude", args, { stdio: ["pipe", "pipe", "pipe"] });
        const stdoutChunks = [];
        const stderrChunks = [];
        let settled = false;
        const timer = setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.kill("SIGTERM");
            reject(new Error(`query planner timed out after ${config.queryPlannerTimeoutMs}ms`));
        }, config.queryPlannerTimeoutMs);
        child.stdout.on("data", (chunk) => stdoutChunks.push(chunk));
        child.stderr.on("data", (chunk) => stderrChunks.push(chunk));
        child.on("error", (err) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            reject(err);
        });
        child.on("close", (code) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timer);
            if (code !== 0) {
                const stderr = Buffer.concat(stderrChunks).toString("utf-8").slice(0, 500);
                reject(new Error(`query planner exited with code ${code}: ${stderr}`));
                return;
            }
            resolve(Buffer.concat(stdoutChunks).toString("utf-8").trim());
        });
        child.stdin.write(prompt, "utf-8");
        child.stdin.end();
    });
}
//# sourceMappingURL=query-planner.js.map
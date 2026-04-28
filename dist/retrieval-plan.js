import { createHash } from "node:crypto";
import { isAbsolute, relative, sep } from "node:path";
function resolveWorkspaceRoot() {
    return process.env.CODEMEMORY_WORKSPACE_ROOT || process.cwd();
}
let cachedWorkspaceKey = null;
function workspaceKey() {
    const root = resolveWorkspaceRoot();
    if (cachedWorkspaceKey?.root === root)
        return cachedWorkspaceKey.key;
    const key = createHash("sha256").update(root).digest("hex").slice(0, 8);
    cachedWorkspaceKey = { root, key };
    return key;
}
export function qualifyFileTag(path) {
    const trimmed = path.trim();
    if (!trimmed)
        return trimmed;
    if (/^[0-9a-f]{8}:/.test(trimmed))
        return trimmed;
    const root = resolveWorkspaceRoot();
    let rel = trimmed;
    if (isAbsolute(trimmed)) {
        const r = relative(root, trimmed);
        if (r && !r.startsWith("..") && !isAbsolute(r)) {
            rel = r;
        }
        else {
            return trimmed;
        }
    }
    rel = rel.split(sep).join("/");
    return `${workspaceKey()}:${rel}`;
}
const KNOWN_BINARIES = new Set([
    "npm",
    "pnpm",
    "yarn",
    "node",
    "tsc",
    "vitest",
    "jest",
    "eslint",
    "prettier",
    "go",
    "cargo",
    "rustc",
    "python",
    "python3",
    "pip",
    "uv",
    "poetry",
    "pytest",
    "make",
    "cmake",
    "bazel",
    "git",
    "docker",
    "kubectl",
]);
const STOPWORDS = new Set([
    "this",
    "that",
    "with",
    "from",
    "into",
    "have",
    "what",
    "when",
    "where",
    "which",
    "should",
    "would",
    "could",
    "about",
    "there",
    "their",
    "them",
    "your",
    "mine",
    "want",
    "need",
    "make",
    "made",
    "code",
    "file",
    "files",
    "function",
    "please",
]);
const CHINESE_STOPWORDS = new Set([
    "请",
    "这个",
    "那个",
    "一下",
    "我们",
    "你",
    "我",
    "是不是",
    "有没有",
    "如何",
    "怎么",
    "然后",
    "之前",
    "当前",
    "这里",
    "好像",
]);
const TOPIC_ALIASES = [
    { topic: "auth", patterns: [/\bauth\b/i, /\blogin\b/i, /登录|鉴权|认证/] },
    { topic: "test", patterns: [/\btest\b/i, /\bvitest\b/i, /\bjest\b/i, /测试|用例/] },
    { topic: "retrieval", patterns: [/\bretriev/i, /检索|召回/] },
    { topic: "compaction", patterns: [/\bcompact/i, /摘要|压缩/] },
    { topic: "memory", patterns: [/\bmemory\b/i, /记忆|历史/] },
    { topic: "dag", patterns: [/\bdag\b/i, /有向无环|图/] },
    { topic: "database", patterns: [/\bsqlite\b/i, /\bdb\b/i, /数据库|迁移/] },
    { topic: "plugin", patterns: [/\bplugin\b/i, /插件|工具/] },
    { topic: "prompt", patterns: [/\bprompt\b/i, /提示词|用户输入/] },
];
/**
 * Pull pivots out of a free-text prompt. This intentionally stays local
 * and deterministic: it is a fast planning pass, not an LLM query.
 */
export function extractPromptPivots(prompt) {
    const text = (prompt || "").slice(0, 4000);
    const filePaths = unique(Array.from(text.matchAll(/(?:[\w./-]+\/)?[\w-]+\.[a-zA-Z]{1,8}\b/g), (m) => m[0]).filter((p) => p.includes("."))).slice(0, 8);
    const commands = [];
    for (const m of text.matchAll(/\b([a-z][a-z0-9_-]{1,15})(?:\s+[\w.:/@-]+)?/g)) {
        const index = m.index ?? -1;
        if (index > 0 && /[./]/.test(text[index - 1] ?? "")) {
            continue;
        }
        const head = m[1];
        if (KNOWN_BINARIES.has(head) && !commands.includes(m[0].trim())) {
            commands.push(m[0].trim());
            if (commands.length >= 6)
                break;
        }
    }
    const symbols = unique(Array.from(text.matchAll(/\b([A-Z][a-zA-Z0-9]{2,}|[a-z]+(?:_[a-z0-9]+){1,})\b/g), (m) => m[1]))
        .filter((s) => s.length > 3 && !KNOWN_BINARIES.has(s.toLowerCase()))
        .slice(0, 10);
    const englishKeywords = unique(text
        .toLowerCase()
        .replace(/[^\w\s]/g, " ")
        .split(/\s+/)
        .filter((w) => w.length > 3 && !STOPWORDS.has(w)));
    const chineseKeywords = unique(Array.from(text.matchAll(/[\u4e00-\u9fff]{2,8}/g), (m) => m[0])
        .flatMap(segmentChinesePhrase)
        .filter((w) => w.length >= 2 && !CHINESE_STOPWORDS.has(w)));
    return {
        keywords: unique([...englishKeywords, ...chineseKeywords]).slice(0, 10),
        filePaths,
        commands,
        symbols,
    };
}
export function createFastRetrievalPlan(prompt) {
    const rawPrompt = (prompt || "").slice(0, 4000);
    const pivots = extractPromptPivots(rawPrompt);
    const topics = inferTopics(rawPrompt, pivots);
    const packages = inferPackages(rawPrompt, pivots);
    const hasFailureSignal = /失败|报错|错误|踩坑|失败过|broken|fail|failed|error|exception|regression/i.test(rawPrompt);
    const hasDecisionSignal = /决策|决定|当时|为什么|原因|取舍|rationale|decision|decide|decided/i.test(rawPrompt);
    const hasModifySignal = /修改|实现|修复|改|更新|edit|modify|fix|change|update/i.test(rawPrompt);
    const hasTestSignal = /测试|跑|重新跑|npm test|pnpm test|yarn test|pytest|vitest|jest/i.test(rawPrompt);
    const intent = hasFailureSignal && (hasModifySignal || hasTestSignal || pivots.filePaths.length > 0)
        ? "modify_and_avoid_prior_failure"
        : hasDecisionSignal
            ? "recall_decision_rationale"
            : hasFailureSignal
                ? "debug_prior_failure"
                : "general_context_lookup";
    const riskLevel = hasFailureSignal || (hasModifySignal && (hasTestSignal || pivots.filePaths.length > 0))
        ? "high"
        : hasDecisionSignal
            ? "medium"
            : "low";
    const wantedKinds = unique([
        "task",
        "constraint",
        ...(hasFailureSignal ? ["failure", "fix_attempt"] : []),
        ...(hasDecisionSignal || hasModifySignal ? ["decision"] : []),
        "summary_anchor",
    ]);
    const tagQueries = buildTagQueries({
        files: pivots.filePaths,
        commands: pivots.commands,
        symbols: pivots.symbols,
        packages,
        topics,
        wantedKinds,
    });
    const queryVariants = unique([
        ...pivots.filePaths,
        ...pivots.commands,
        ...topics.map((topic) => `${topic} ${hasFailureSignal ? "failure" : "decision"}`.trim()),
        ...pivots.symbols,
        ...pivots.keywords.slice(0, 4),
    ]).slice(0, 8);
    return {
        rawPrompt,
        intent,
        riskLevel,
        entities: {
            files: pivots.filePaths,
            commands: pivots.commands,
            symbols: pivots.symbols,
            packages,
            topics,
        },
        wantedKinds,
        scope: {
            preferCurrentConversation: true,
            allowCrossSessionFailures: true,
        },
        queryVariants,
        tagQueries,
        recallPolicy: {
            maxCandidates: riskLevel === "high" ? 40 : 24,
            maxInjectedItems: riskLevel === "high" ? 8 : 5,
            tokenBudget: riskLevel === "high" ? 1600 : 1000,
            expandSummaries: true,
            maxSummaryDepth: 1,
            minScore: riskLevel === "high" ? 0.5 : 0.6,
        },
    };
}
export function inferTopics(text, _pivots = extractPromptPivots(text)) {
    const topics = [];
    for (const item of TOPIC_ALIASES) {
        if (item.patterns.some((re) => re.test(text))) {
            topics.push(item.topic);
        }
    }
    return unique(topics).slice(0, 10);
}
export function normalizeTagValue(value) {
    return value.trim().replace(/\s+/g, " ").toLowerCase();
}
export function commandVariants(command) {
    const normalized = normalizeTagValue(command);
    if (!normalized)
        return [];
    const tokens = normalized.split(" ").filter(Boolean);
    if (tokens.length === 0)
        return [];
    const prefix = semanticCommandPrefix(tokens);
    return unique([normalized, prefix]).filter(Boolean);
}
function buildTagQueries(input) {
    const tags = [];
    for (const file of input.files)
        tags.push({ tagType: "file", tagValue: qualifyFileTag(file), weight: 2.2 });
    for (const command of input.commands) {
        const variants = commandVariants(command);
        for (const [index, variant] of variants.entries()) {
            tags.push({
                tagType: "command",
                tagValue: variant,
                weight: index === 0 ? 1.9 : 1.2,
            });
        }
    }
    for (const symbol of input.symbols)
        tags.push({ tagType: "symbol", tagValue: symbol, weight: 1.4 });
    for (const pkg of input.packages)
        tags.push({ tagType: "package", tagValue: pkg, weight: 1.2 });
    for (const topic of input.topics)
        tags.push({ tagType: "topic", tagValue: topic, weight: 1.0 });
    for (const kind of input.wantedKinds)
        tags.push({ tagType: "kind", tagValue: kind, weight: 0.8 });
    const seen = new Set();
    return tags.filter((tag) => {
        const key = `${tag.tagType}:${normalizeTagValue(tag.tagValue)}`;
        if (seen.has(key))
            return false;
        seen.add(key);
        return true;
    });
}
function inferPackages(text, pivots) {
    const packageNames = unique([
        ...Array.from(text.matchAll(/(?:@[\w-]+\/)?[\w-]+(?=@\d|\sversion|\s包)/g), (m) => m[0]),
        ...pivots.commands
            .filter((cmd) => /^(npm|pnpm|yarn)\s+(add|install|remove|why)\b/.test(cmd))
            .map((cmd) => cmd.trim().split(/\s+/).at(-1) || "")
            .filter(Boolean),
    ]);
    return packageNames.filter((p) => p.length > 1 && !KNOWN_BINARIES.has(p)).slice(0, 6);
}
function semanticCommandPrefix(tokens) {
    if (tokens.length === 1)
        return tokens[0];
    const second = tokens[1];
    if (second === "run" || second === "exec" || second === "-m") {
        return tokens.slice(0, Math.min(tokens.length, 3)).join(" ");
    }
    return tokens.slice(0, 2).join(" ");
}
function segmentChinesePhrase(phrase) {
    const hits = new Set();
    const known = [
        "召回",
        "检索",
        "准确率",
        "摘要",
        "决策",
        "决定",
        "错误",
        "失败",
        "修复",
        "测试",
        "工具",
        "提示词",
        "用户输入",
        "历史",
        "实现",
        "计划",
        "生产",
        "上下文",
    ];
    for (const word of known) {
        if (phrase.includes(word))
            hits.add(word);
    }
    if (hits.size === 0 && phrase.length <= 6)
        hits.add(phrase);
    return Array.from(hits);
}
function unique(items) {
    return Array.from(new Set(items));
}
//# sourceMappingURL=retrieval-plan.js.map
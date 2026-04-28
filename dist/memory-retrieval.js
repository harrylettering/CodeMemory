export class MemoryRetrievalEngine {
    memoryStore;
    summaryStore;
    constructor(memoryStore, summaryStore) {
        this.memoryStore = memoryStore;
        this.summaryStore = summaryStore;
    }
    async retrieve(input) {
        const candidates = await this.memoryStore.searchByPlan(input.plan, {
            conversationId: input.conversationId,
            limit: input.plan.recallPolicy.maxCandidates,
        });
        const selected = selectWithinBudget(candidates, input.plan.recallPolicy.maxInjectedItems, input.plan.recallPolicy.tokenBudget);
        const selectedTokens = selected.reduce((sum, item) => sum + estimateTokens(item.node.content), 0);
        const stitchedRelationResult = await this.buildRelationStitch(selected, input.plan, input.conversationId, Math.max(0, input.plan.recallPolicy.tokenBudget - selectedTokens));
        const stitchedRelations = stitchedRelationResult.relations;
        const stitchedChainResult = await this.buildStitchedChains(selected, stitchedRelations, input.plan, input.conversationId, Math.max(0, input.plan.recallPolicy.tokenBudget - selectedTokens));
        const stitchedChains = stitchedChainResult.chains;
        const stitchedTokens = stitchedChains.reduce((sum, chain) => sum + estimateStitchedChainTokens(chain), 0);
        const summaryCandidates = selected.concat(stitchedChains.flatMap((chain) => chain.nodes
            .filter((node) => !selected.some((candidate) => candidate.node.nodeId === node.nodeId))
            .map((node) => ({
            node,
            score: chain.score,
            matchedTags: [],
        }))));
        const summaryEvidence = await this.buildSummaryEvidence(summaryCandidates, input.plan, Math.max(0, input.plan.recallPolicy.tokenBudget - selectedTokens - stitchedTokens));
        await this.memoryStore.markUsed(Array.from(new Set([
            ...selected.map((item) => item.node.nodeId),
            ...stitchedChains.flatMap((chain) => chain.nodes.map((node) => node.nodeId)),
        ])));
        const estimatedTokens = selectedTokens +
            stitchedTokens +
            Array.from(summaryEvidence.values()).reduce((sum, evidence) => sum + estimateEvidenceTokens(evidence), 0);
        return {
            nodes: selected,
            stitchedRelations,
            stitchedChains,
            markdown: renderMemoryMarkdown(selected, summaryEvidence, stitchedChains),
            estimatedTokens,
            summaryEvidence,
            stats: {
                candidateCount: candidates.length,
                selectedNodeCount: selected.length,
                stitchedRelationCount: stitchedRelations.length,
                stitchedChainCount: stitchedChains.length,
                summaryEvidenceCount: summaryEvidence.size,
                relationQueryBatches: stitchedRelationResult.stats.relationQueryBatches +
                    stitchedChainResult.stats.relationQueryBatches,
                firstHopNodeCount: stitchedRelationResult.stats.queriedNodeCount,
                firstHopRelationCount: stitchedRelationResult.stats.fetchedRelationCount,
                secondHopNodeCount: stitchedChainResult.stats.queriedNodeCount,
                secondHopRelationCount: stitchedChainResult.stats.fetchedRelationCount,
                estimatedTokens,
            },
        };
    }
    async buildRelationStitch(candidates, plan, conversationId, tokenBudget) {
        if (candidates.length === 0 || tokenBudget < 80) {
            return {
                relations: [],
                stats: {
                    relationQueryBatches: 0,
                    queriedNodeCount: 0,
                    fetchedRelationCount: 0,
                },
            };
        }
        const remainingTokens = Math.min(tokenBudget, Math.max(120, Math.ceil(plan.recallPolicy.tokenBudget * 0.28)));
        const candidateMap = new Map(candidates.map((candidate) => [candidate.node.nodeId, candidate.node]));
        const relationGroups = await this.memoryStore.getRelationsForNodes(candidates.map((candidate) => candidate.node.nodeId), "both");
        const rawRelations = new Map();
        for (const candidate of candidates) {
            const relations = relationGroups.get(candidate.node.nodeId) ?? [];
            for (const relation of relations) {
                const key = `${relation.fromNodeId}\0${relation.toNodeId}\0${relation.relationType}`;
                const existing = rawRelations.get(key);
                if (existing) {
                    existing.anchorNodeIds.add(candidate.node.nodeId);
                    existing.anchorScore = Math.max(existing.anchorScore, candidate.score);
                    continue;
                }
                rawRelations.set(key, {
                    relation,
                    anchorNodeIds: new Set([candidate.node.nodeId]),
                    anchorScore: candidate.score,
                });
            }
        }
        const nodeMap = new Map((await this.memoryStore.getNodes(Array.from(rawRelations.values()).flatMap((item) => [
            item.relation.fromNodeId,
            item.relation.toNodeId,
        ])))
            .filter((node) => node.status !== "stale")
            .map((node) => [node.nodeId, node]));
        const stitched = Array.from(rawRelations.values())
            .map((item) => {
            const fromNode = nodeMap.get(item.relation.fromNodeId);
            const toNode = nodeMap.get(item.relation.toNodeId);
            if (!fromNode || !toNode)
                return null;
            const anchorNodes = Array.from(item.anchorNodeIds)
                .map((nodeId) => candidateMap.get(nodeId))
                .filter((node) => !!node);
            let intentBonus = 0;
            const keep = anchorNodes.some((anchorNode) => {
                const otherNode = otherNodeForRawRelation(item.relation, anchorNode.nodeId, fromNode, toNode);
                if (!otherNode ||
                    !shouldKeepRelationForIntent(plan.intent, anchorNode.kind, item.relation.relationType, otherNode.kind)) {
                    return false;
                }
                intentBonus = Math.max(intentBonus, relationIntentBonus(plan.intent, anchorNode.kind, item.relation.relationType, otherNode.kind));
                return true;
            });
            if (!keep)
                return null;
            return {
                relationType: item.relation.relationType,
                confidence: item.relation.confidence,
                score: Number((item.anchorScore * 0.45 +
                    item.relation.confidence * relationPriority(item.relation.relationType) +
                    relationConversationBonus(fromNode, toNode, conversationId) +
                    intentBonus).toFixed(3)),
                fromNode,
                toNode,
                anchorNodeIds: Array.from(item.anchorNodeIds),
            };
        })
            .filter((item) => !!item)
            .sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
            return b.confidence - a.confidence;
        });
        const selected = [];
        let usedTokens = 0;
        for (const relation of stitched) {
            const needed = estimateStitchedRelationTokens(relation);
            if (selected.length >= 6)
                break;
            if (usedTokens + needed > remainingTokens && selected.length > 0)
                continue;
            selected.push(relation);
            usedTokens += needed;
        }
        return {
            relations: selected,
            stats: {
                relationQueryBatches: 1,
                queriedNodeCount: candidates.length,
                fetchedRelationCount: uniqueRelationCount(relationGroups),
            },
        };
    }
    async buildSummaryEvidence(candidates, plan, tokenBudget) {
        const evidence = new Map();
        if (!this.summaryStore || !plan.recallPolicy.expandSummaries)
            return evidence;
        if (plan.recallPolicy.maxSummaryDepth <= 0 || tokenBudget < 80)
            return evidence;
        let remainingTokens = Math.min(tokenBudget, Math.ceil(plan.recallPolicy.tokenBudget * 0.35));
        for (const candidate of candidates) {
            if (remainingTokens < 40)
                break;
            if (candidate.node.kind !== "summary" || !candidate.node.summaryId)
                continue;
            const built = await buildEvidenceForSummary(this.summaryStore, candidate.node.summaryId, remainingTokens);
            if (!built)
                continue;
            const used = estimateEvidenceTokens(built);
            if (used > remainingTokens && evidence.size > 0)
                continue;
            evidence.set(candidate.node.nodeId, built);
            remainingTokens -= used;
        }
        return evidence;
    }
    async buildStitchedChains(candidates, stitchedRelations, plan, conversationId, tokenBudget) {
        if (candidates.length === 0 || stitchedRelations.length === 0 || tokenBudget < 80) {
            return {
                chains: [],
                stats: {
                    relationQueryBatches: 0,
                    queriedNodeCount: 0,
                    fetchedRelationCount: 0,
                },
            };
        }
        const relationMapByNode = new Map();
        for (const relation of stitchedRelations) {
            indexRelation(relationMapByNode, relation.fromNode.nodeId, relation);
            indexRelation(relationMapByNode, relation.toNode.nodeId, relation);
        }
        const middleNodeIds = Array.from(new Set(stitchedRelations.flatMap((relation) => [
            relation.fromNode.nodeId,
            relation.toNode.nodeId,
        ])));
        const secondHopGroups = await this.memoryStore.getRelationsForNodes(middleNodeIds, "both");
        const secondHopNodeIds = Array.from(new Set(Array.from(secondHopGroups.values()).flatMap((relations) => relations.flatMap((relation) => [relation.fromNodeId, relation.toNodeId]))));
        const nodeMap = new Map((await this.memoryStore.getNodes(secondHopNodeIds))
            .filter((node) => node.status !== "stale")
            .map((node) => [node.nodeId, node]));
        for (const relation of stitchedRelations) {
            nodeMap.set(relation.fromNode.nodeId, relation.fromNode);
            nodeMap.set(relation.toNode.nodeId, relation.toNode);
        }
        const chains = new Map();
        for (const candidate of candidates) {
            const firstHopRelations = relationMapByNode.get(candidate.node.nodeId) ?? [];
            for (const firstHop of firstHopRelations) {
                const middleNode = otherNodeForRelation(firstHop, candidate.node.nodeId);
                if (!middleNode)
                    continue;
                if (!shouldKeepRelationForIntent(plan.intent, candidate.node.kind, firstHop.relationType, middleNode.kind)) {
                    continue;
                }
                addChain(chains, {
                    score: chainScore(candidate.score, [firstHop.relationType], [firstHop.confidence], [candidate.node, middleNode], conversationId, plan.intent),
                    confidence: firstHop.confidence,
                    nodes: [candidate.node, middleNode],
                    edges: [
                        {
                            relationType: firstHop.relationType,
                            confidence: firstHop.confidence,
                            fromNodeId: firstHop.fromNode.nodeId,
                            toNodeId: firstHop.toNode.nodeId,
                        },
                    ],
                    anchorNodeIds: firstHop.anchorNodeIds,
                });
                const secondHopRelations = secondHopGroups.get(middleNode.nodeId) ?? [];
                for (const rawRelation of secondHopRelations) {
                    const tailNodeId = otherNodeId(rawRelation, middleNode.nodeId);
                    if (!tailNodeId || tailNodeId === candidate.node.nodeId)
                        continue;
                    const tailNode = nodeMap.get(tailNodeId);
                    if (!tailNode || tailNode.nodeId === middleNode.nodeId)
                        continue;
                    if (!shouldKeepRelationForIntent(plan.intent, middleNode.kind, rawRelation.relationType, tailNode.kind) ||
                        !shouldKeepTwoHopChain(plan.intent, [candidate.node, middleNode, tailNode], [
                            firstHop.relationType,
                            rawRelation.relationType,
                        ])) {
                        continue;
                    }
                    addChain(chains, {
                        score: chainScore(candidate.score, [firstHop.relationType, rawRelation.relationType], [firstHop.confidence, rawRelation.confidence], [candidate.node, middleNode, tailNode], conversationId, plan.intent),
                        confidence: Number(((firstHop.confidence + rawRelation.confidence) / 2).toFixed(3)),
                        nodes: [candidate.node, middleNode, tailNode],
                        edges: [
                            {
                                relationType: firstHop.relationType,
                                confidence: firstHop.confidence,
                                fromNodeId: firstHop.fromNode.nodeId,
                                toNodeId: firstHop.toNode.nodeId,
                            },
                            {
                                relationType: rawRelation.relationType,
                                confidence: rawRelation.confidence,
                                fromNodeId: rawRelation.fromNodeId,
                                toNodeId: rawRelation.toNodeId,
                            },
                        ],
                        anchorNodeIds: Array.from(new Set([...firstHop.anchorNodeIds, candidate.node.nodeId])),
                    });
                }
            }
        }
        const ordered = Array.from(chains.values()).sort((a, b) => {
            if (b.score !== a.score)
                return b.score - a.score;
            if (b.edges.length !== a.edges.length)
                return b.edges.length - a.edges.length;
            return b.confidence - a.confidence;
        });
        const selectedChains = [];
        const remainingTokens = Math.min(tokenBudget, Math.max(140, Math.ceil(tokenBudget * 0.32)));
        let usedTokens = 0;
        for (const chain of ordered) {
            const needed = estimateStitchedChainTokens(chain);
            if (selectedChains.length >= 5)
                break;
            if (usedTokens + needed > remainingTokens && selectedChains.length > 0)
                continue;
            selectedChains.push(chain);
            usedTokens += needed;
        }
        return {
            chains: selectedChains,
            stats: {
                relationQueryBatches: middleNodeIds.length > 0 ? 1 : 0,
                queriedNodeCount: middleNodeIds.length,
                fetchedRelationCount: uniqueRelationCount(secondHopGroups),
            },
        };
    }
}
export function renderMemoryMarkdown(candidates, summaryEvidence = new Map(), stitchedChains = []) {
    if (candidates.length === 0 && stitchedChains.length === 0)
        return "";
    const tasks = candidates.filter((c) => c.node.kind === "task");
    const constraints = candidates.filter((c) => c.node.kind === "constraint");
    const failures = candidates.filter((c) => c.node.kind === "failure");
    const decisions = candidates.filter((c) => c.node.kind === "decision");
    const summaries = candidates.filter((c) => c.node.kind === "summary");
    const others = candidates.filter((c) => c.node.kind !== "task" &&
        c.node.kind !== "constraint" &&
        c.node.kind !== "failure" &&
        c.node.kind !== "decision" &&
        c.node.kind !== "summary");
    const blocks = [];
    if (tasks.length > 0) {
        blocks.push(`### Current Task Memory\n\n${renderList(tasks, 340, summaryEvidence)}`);
    }
    if (constraints.length > 0) {
        blocks.push(`### Active Constraint Memory\n\n${renderList(constraints, 320, summaryEvidence)}`);
    }
    if (failures.length > 0) {
        blocks.push(`### Prior Failure Memory\n\n${renderList(failures, 360, summaryEvidence)}`);
    }
    if (decisions.length > 0) {
        blocks.push(`### Decision Memory\n\n${renderList(decisions, 320, summaryEvidence)}`);
    }
    if (summaries.length > 0) {
        blocks.push(`### Summary Anchor Memory\n\n${renderList(summaries, 300, summaryEvidence)}`);
    }
    if (stitchedChains.length > 0) {
        blocks.push(`### Stitched Memory Chain\n\n${renderChainList(stitchedChains, summaryEvidence)}`);
    }
    if (others.length > 0) {
        blocks.push(`### Related Memory\n\n${renderList(others, 260, summaryEvidence)}`);
    }
    return blocks.join("\n\n");
}
function selectWithinBudget(candidates, maxItems, tokenBudget) {
    const selected = [];
    let usedTokens = 0;
    for (const candidate of candidates) {
        const tokens = estimateTokens(candidate.node.content);
        if (selected.length >= maxItems)
            break;
        if (usedTokens + tokens > tokenBudget && selected.length > 0)
            continue;
        selected.push(candidate);
        usedTokens += tokens;
    }
    return selected;
}
function renderList(candidates, maxChars, summaryEvidence) {
    return candidates
        .map((candidate) => {
        const node = candidate.node;
        const status = node.status;
        const source = renderSource(node);
        const snippet = node.content.replace(/\s+/g, " ").slice(0, maxChars);
        const evidence = renderSummaryEvidence(summaryEvidence.get(node.nodeId));
        return `- (${node.kind}, ${status}, score ${candidate.score}) ${snippet}${source}${evidence}`;
    })
        .join("\n");
}
function renderChainList(chains, summaryEvidence) {
    return chains
        .map((chain) => {
        const parts = [renderRelationNodeSnippet(chain.nodes[0], 96)];
        for (let index = 0; index < chain.edges.length; index += 1) {
            parts.push(renderChainConnector(chain.edges[index], chain.nodes[index], chain.nodes[index + 1]));
            parts.push(renderRelationNodeSnippet(chain.nodes[index + 1], 96));
        }
        const evidence = chain.nodes
            .map((node) => renderSummaryEvidence(summaryEvidence.get(node.nodeId)))
            .filter(Boolean)
            .join(" | ");
        return `- (${chain.edges.length}-hop, score ${chain.score}) ${parts.join(" ")}${evidence ? ` Evidence: ${evidence}` : ""}`;
    })
        .join("\n");
}
function renderChainConnector(edge, fromNode, toNode) {
    if (edge.fromNodeId === fromNode.nodeId && edge.toNodeId === toNode.nodeId) {
        return `-[${edge.relationType}]->`;
    }
    if (edge.fromNodeId === toNode.nodeId && edge.toNodeId === fromNode.nodeId) {
        return `<-[${edge.relationType}]-`;
    }
    return `-(${edge.relationType})-`;
}
function renderRelationNodeSnippet(node, maxChars) {
    const snippet = node.content.replace(/\s+/g, " ").slice(0, maxChars);
    return `${node.kind}:${snippet}${renderSource(node)}`;
}
function renderSource(node) {
    if (node.summaryId)
        return ` [summary:${node.summaryId}]`;
    const messageId = node.metadata.messageId;
    if (messageId)
        return ` [message:${String(messageId)}]`;
    if (node.sourceId)
        return ` [${node.source}:${node.sourceId}]`;
    return "";
}
function estimateTokens(content) {
    return Math.ceil(content.length / 4);
}
async function buildEvidenceForSummary(summaryStore, summaryId, tokenBudget) {
    const root = await summaryStore.getSummary(summaryId);
    if (!root)
        return null;
    const evidence = {
        rootSummaryId: root.summaryId,
        rootKind: root.kind,
        children: [],
        truncated: false,
    };
    let remainingTokens = tokenBudget;
    if (root.kind === "condensed") {
        const children = await summaryStore.getSummaryChildren(summaryId);
        for (const child of children) {
            const snippet = toEvidenceSnippet(child);
            const needed = estimateTokens(snippet.content);
            if (needed > remainingTokens && evidence.children.length > 0) {
                evidence.truncated = true;
                break;
            }
            evidence.children.push(snippet);
            remainingTokens -= needed;
            if (evidence.children.length >= 3) {
                evidence.truncated = children.length > evidence.children.length;
                break;
            }
        }
        return evidence.children.length > 0 ? evidence : null;
    }
    const messageIds = await summaryStore.getSummaryMessages(summaryId);
    evidence.sourceMessageCount = messageIds.length;
    return evidence;
}
function toEvidenceSnippet(summary) {
    return {
        summaryId: summary.summaryId,
        kind: summary.kind,
        content: summary.content.replace(/\s+/g, " ").slice(0, 180),
    };
}
function renderSummaryEvidence(evidence) {
    if (!evidence)
        return "";
    const parts = [];
    if (evidence.children.length > 0) {
        const children = evidence.children
            .map((child) => `${child.summaryId}: ${child.content}`)
            .join(" | ");
        parts.push(`child summaries: ${children}`);
    }
    else if (typeof evidence.sourceMessageCount === "number") {
        parts.push(`source messages: ${evidence.sourceMessageCount}`);
    }
    if (evidence.truncated)
        parts.push("evidence truncated");
    if (parts.length === 0)
        return "";
    return ` Evidence: ${parts.join("; ")}`;
}
function estimateEvidenceTokens(evidence) {
    const childrenTokens = evidence.children.reduce((sum, child) => sum + estimateTokens(child.content), 0);
    return childrenTokens + 16;
}
function estimateStitchedChainTokens(chain) {
    const parts = [renderRelationNodeSnippet(chain.nodes[0], 96)];
    for (let index = 0; index < chain.edges.length; index += 1) {
        parts.push(renderChainConnector(chain.edges[index], chain.nodes[index], chain.nodes[index + 1]));
        parts.push(renderRelationNodeSnippet(chain.nodes[index + 1], 96));
    }
    return estimateTokens(parts.join(" ")) + 12;
}
function estimateStitchedRelationTokens(relation) {
    const from = renderRelationNodeSnippet(relation.fromNode, 96);
    const to = renderRelationNodeSnippet(relation.toNode, 96);
    return estimateTokens(`${from} ${relation.relationType} ${to}`) + 10;
}
function relationPriority(relationType) {
    switch (relationType) {
        case "resolves":
            return 1.45;
        case "attemptedFixFor":
            return 1.35;
        case "causedBy":
            return 1.25;
        case "supersedes":
        case "supersededBy":
            return 1.18;
        case "conflictsWith":
            return 1.12;
        case "relatedTo":
            return 0.95;
        case "derivedFromSummary":
            return 0.82;
        case "evidenceOf":
            return 0.78;
        default:
            return 0.9;
    }
}
function relationConversationBonus(fromNode, toNode, conversationId) {
    if (!conversationId)
        return 0;
    if (fromNode.conversationId === conversationId && toNode.conversationId === conversationId) {
        return 0.2;
    }
    if (fromNode.conversationId === conversationId || toNode.conversationId === conversationId) {
        return 0.1;
    }
    return 0;
}
function chainScore(anchorScore, relationTypes, confidences, nodes, conversationId, intent) {
    const relationScore = relationTypes.reduce((sum, relationType, index) => {
        const depthFactor = index === 0 ? 1 : 0.78;
        return sum + relationPriority(relationType) * (confidences[index] ?? 0.8) * depthFactor;
    }, 0);
    const conversationScore = nodes.reduce((sum, node, index) => {
        if (!conversationId || node.conversationId !== conversationId)
            return sum;
        return sum + (index === 0 ? 0.12 : 0.08);
    }, 0);
    const diversityBonus = nodes.length >= 3 ? 0.18 : 0.06;
    return Number((anchorScore * 0.34 +
        relationScore +
        conversationScore +
        diversityBonus +
        chainIntentBonus(intent, nodes, relationTypes)).toFixed(3));
}
function indexRelation(relationMapByNode, nodeId, relation) {
    const relations = relationMapByNode.get(nodeId);
    if (relations) {
        relations.push(relation);
        return;
    }
    relationMapByNode.set(nodeId, [relation]);
}
function otherNodeForRelation(relation, nodeId) {
    if (relation.fromNode.nodeId === nodeId)
        return relation.toNode;
    if (relation.toNode.nodeId === nodeId)
        return relation.fromNode;
    return null;
}
function otherNodeId(relation, nodeId) {
    if (relation.fromNodeId === nodeId)
        return relation.toNodeId;
    if (relation.toNodeId === nodeId)
        return relation.fromNodeId;
    return null;
}
function otherNodeForRawRelation(relation, nodeId, fromNode, toNode) {
    if (relation.fromNodeId === nodeId)
        return toNode;
    if (relation.toNodeId === nodeId)
        return fromNode;
    return null;
}
function uniqueRelationCount(groups) {
    const relationIds = new Set();
    for (const relations of groups.values()) {
        for (const relation of relations) {
            relationIds.add(relation.relationId);
        }
    }
    return relationIds.size;
}
function addChain(chains, chain) {
    const key = `${chain.nodes.map((node) => node.nodeId).join("->")}|${chain.edges
        .map((edge) => `${edge.fromNodeId}:${edge.relationType}:${edge.toNodeId}`)
        .join("|")}`;
    const existing = chains.get(key);
    if (!existing || chain.score > existing.score) {
        chains.set(key, chain);
    }
}
function shouldKeepRelationForIntent(intent, anchorKind, relationType, otherKind) {
    const allowedKinds = allowedKindsForIntent(intent);
    if (!allowedKinds.has(anchorKind) || !allowedKinds.has(otherKind))
        return false;
    switch (relationType) {
        case "attemptedFixFor":
        case "resolves":
        case "causedBy":
            return intent === "modify_and_avoid_prior_failure" || intent === "debug_prior_failure";
        case "supersedes":
        case "supersededBy":
            return anchorKind === otherKind &&
                (anchorKind === "decision" || anchorKind === "task" || anchorKind === "constraint");
        case "conflictsWith":
            return intent !== "debug_prior_failure" &&
                (anchorKind === "decision" || otherKind === "decision");
        case "derivedFromSummary":
        case "evidenceOf":
            return intent === "recall_decision_rationale" || intent === "general_context_lookup";
        case "relatedTo":
            return relatedPairAllowedForIntent(intent, anchorKind, otherKind);
        default:
            return false;
    }
}
function relatedPairAllowedForIntent(intent, leftKind, rightKind) {
    const kinds = new Set([leftKind, rightKind]);
    switch (intent) {
        case "modify_and_avoid_prior_failure":
            return !kinds.has("summary");
        case "recall_decision_rationale":
            return !kinds.has("failure") && !kinds.has("fix_attempt");
        case "debug_prior_failure":
            return (kinds.has("failure") ||
                kinds.has("fix_attempt") ||
                (kinds.has("task") && kinds.has("decision")) ||
                (kinds.has("task") && kinds.has("constraint")));
        case "general_context_lookup":
        default:
            return (!kinds.has("failure") &&
                !kinds.has("fix_attempt"));
    }
}
function allowedKindsForIntent(intent) {
    switch (intent) {
        case "modify_and_avoid_prior_failure":
            return new Set(["task", "constraint", "decision", "failure", "fix_attempt"]);
        case "recall_decision_rationale":
            return new Set(["task", "constraint", "decision", "summary"]);
        case "debug_prior_failure":
            return new Set(["task", "constraint", "decision", "failure", "fix_attempt"]);
        case "general_context_lookup":
        default:
            return new Set(["task", "constraint", "decision", "summary"]);
    }
}
function shouldKeepTwoHopChain(intent, nodes, relationTypes) {
    const kinds = nodes.map((node) => node.kind);
    const kindSet = new Set(kinds);
    switch (intent) {
        case "modify_and_avoid_prior_failure":
            return ((matchesKinds(kinds, ["task", "fix_attempt", "failure"]) &&
                relationTypes.some((type) => type === "attemptedFixFor" || type === "resolves")) ||
                matchesKinds(kinds, ["task", "decision", "failure"]) ||
                matchesKinds(kinds, ["task", "decision", "constraint"]) ||
                matchesKinds(kinds, ["task", "constraint", "decision"]) ||
                matchesKinds(kinds, ["decision", "fix_attempt", "failure"]) ||
                matchesKinds(kinds, ["failure", "fix_attempt", "decision"]));
        case "recall_decision_rationale":
            return !kindSet.has("failure") &&
                !kindSet.has("fix_attempt") &&
                (kindSet.has("decision") || kindSet.has("summary"));
        case "debug_prior_failure":
            return !kindSet.has("summary") &&
                (kindSet.has("failure") || kindSet.has("fix_attempt")) &&
                (kindSet.has("failure") && kindSet.has("fix_attempt") ||
                    (kindSet.has("failure") && kindSet.has("decision")) ||
                    (kindSet.has("failure") && kindSet.has("task")));
        case "general_context_lookup":
        default:
            return !kindSet.has("failure") &&
                !kindSet.has("fix_attempt") &&
                (kindSet.has("task") || kindSet.has("constraint")) &&
                (kindSet.has("decision") || kindSet.has("summary"));
    }
}
function relationIntentBonus(intent, anchorKind, relationType, otherKind) {
    if (intent === "modify_and_avoid_prior_failure") {
        if ((relationType === "attemptedFixFor" || relationType === "resolves") &&
            ((anchorKind === "fix_attempt" && otherKind === "failure") ||
                (anchorKind === "failure" && otherKind === "fix_attempt"))) {
            return 0.32;
        }
        if (anchorKind === "task" && (otherKind === "decision" || otherKind === "constraint")) {
            return 0.18;
        }
    }
    if (intent === "recall_decision_rationale") {
        if (relationType === "supersedes" || relationType === "conflictsWith")
            return 0.28;
        if (otherKind === "summary" || anchorKind === "summary")
            return 0.18;
    }
    if (intent === "debug_prior_failure") {
        if (otherKind === "failure" || anchorKind === "failure")
            return 0.22;
        if (otherKind === "fix_attempt" || anchorKind === "fix_attempt")
            return 0.18;
    }
    if (intent === "general_context_lookup") {
        if (anchorKind === "task" || anchorKind === "constraint")
            return 0.12;
    }
    return 0;
}
function chainIntentBonus(intent, nodes, relationTypes) {
    const kinds = nodes.map((node) => node.kind);
    const kindSet = new Set(kinds);
    switch (intent) {
        case "modify_and_avoid_prior_failure":
            if (matchesKinds(kinds, ["task", "fix_attempt", "failure"]) &&
                relationTypes.some((type) => type === "attemptedFixFor" || type === "resolves")) {
                return 0.42;
            }
            if (matchesKinds(kinds, ["task", "decision", "failure"]))
                return 0.28;
            if (matchesKinds(kinds, ["task", "decision", "constraint"]))
                return 0.22;
            break;
        case "recall_decision_rationale":
            if (kindSet.has("decision") && kindSet.has("summary")) {
                return 0.34;
            }
            if (relationTypes.some((type) => type === "supersedes" || type === "conflictsWith")) {
                return 0.28;
            }
            break;
        case "debug_prior_failure":
            if (kindSet.has("failure") && kindSet.has("fix_attempt"))
                return 0.36;
            if (kindSet.has("failure") && kindSet.has("decision"))
                return 0.24;
            break;
        case "general_context_lookup":
        default:
            if ((kindSet.has("task") || kindSet.has("constraint")) &&
                (kindSet.has("decision") || kindSet.has("summary"))) {
                return 0.18;
            }
            break;
    }
    return 0;
}
function matchesKinds(kinds, expected) {
    return kinds.length === expected.length && kinds.every((kind, index) => kind === expected[index]);
}
//# sourceMappingURL=memory-retrieval.js.map
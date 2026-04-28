export class LifecycleResolver {
    memoryStore;
    constructor(memoryStore) {
        this.memoryStore = memoryStore;
    }
    async resolveFailuresForSucceededAttempt(input) {
        const candidates = await this.memoryStore.findActiveFailuresByAnchors({
            conversationId: input.conversationId,
            files: input.files,
            commands: input.commands,
            limit: 8,
        });
        if (candidates.length === 0) {
            return {
                action: "none",
                transition: "resolve_failure",
                targetNodeIds: [],
                confidence: 0,
                reason: "no active failure matched the succeeded attempt anchors",
            };
        }
        const decision = chooseStrongFailureTarget(candidates);
        const reason = input.reason ??
            "validation command succeeded after fix attempt with matching anchors";
        if (!decision) {
            await this.memoryStore.addPendingUpdate({
                transition: "resolve_failure",
                eventType: "resolve_failure_after_fix_attempt",
                targetCandidates: candidates.map((candidate) => ({
                    nodeId: candidate.node.nodeId,
                    score: candidate.score,
                    reason: candidate.matchedAnchors.join(", "),
                })),
                fromStatus: "active",
                toStatus: "resolved",
                confidence: estimateAmbiguousConfidence(candidates),
                reason: "ambiguous active failure candidates for succeeded fix attempt",
                evidenceMessageId: input.evidenceMessageId,
                metadata: {
                    fixAttemptNodeId: input.fixAttemptNodeId,
                    files: input.files,
                    commands: input.commands,
                },
            });
            return {
                action: "pending",
                transition: "resolve_failure",
                targetNodeIds: candidates.map((candidate) => candidate.node.nodeId),
                confidence: estimateAmbiguousConfidence(candidates),
                reason: "ambiguous active failure candidates for succeeded fix attempt",
            };
        }
        await this.memoryStore.addRelation({
            fromNodeId: input.fixAttemptNodeId,
            toNodeId: decision.node.nodeId,
            relationType: "resolves",
            confidence: decision.confidence,
            evidenceMessageId: input.evidenceMessageId,
            metadata: {
                files: input.files,
                commands: input.commands,
                matchedAnchors: decision.matchedAnchors,
            },
        });
        await this.memoryStore.updateNodeStatus({
            nodeId: decision.node.nodeId,
            toStatus: "resolved",
            eventType: "resolve_failure_after_fix_attempt",
            confidence: decision.confidence,
            reason,
            evidenceMessageId: input.evidenceMessageId,
            metadata: {
                resolved: true,
                resolution: reason,
                resolvedByFixAttempt: input.fixAttemptNodeId,
            },
            lifecycle: {
                resolvedBy: "fix_attempt",
                resolvedByFixAttempt: input.fixAttemptNodeId,
            },
        });
        return {
            action: "applied",
            transition: "resolve_failure",
            targetNodeIds: [decision.node.nodeId],
            confidence: decision.confidence,
            reason,
        };
    }
    async reopenFailure(input) {
        const reason = input.reason ?? "failure recurred after being resolved";
        if (input.nodeId) {
            const node = await this.memoryStore.getNode(input.nodeId);
            if (!node || node.kind !== "failure") {
                return {
                    action: "none",
                    transition: "reopen_failure",
                    targetNodeIds: [],
                    confidence: 0,
                    reason: `failure node ${input.nodeId} not found`,
                };
            }
            if (node.status === "active") {
                return {
                    action: "none",
                    transition: "reopen_failure",
                    targetNodeIds: [node.nodeId],
                    confidence: 1,
                    reason: "failure is already active",
                };
            }
            await this.applyFailureReopen(node, 0.95, reason, input);
            return {
                action: "applied",
                transition: "reopen_failure",
                targetNodeIds: [node.nodeId],
                confidence: 0.95,
                reason,
            };
        }
        const candidates = await this.memoryStore.findFailuresByAnchors({
            conversationId: input.conversationId,
            files: input.files,
            commands: input.commands,
            symbols: input.symbols,
            signatures: input.signatures,
            statuses: ["resolved", "stale"],
            limit: 8,
        });
        if (candidates.length === 0) {
            return {
                action: "none",
                transition: "reopen_failure",
                targetNodeIds: [],
                confidence: 0,
                reason: "no resolved or stale failure matched recurrence anchors",
            };
        }
        const decision = chooseStrongFailureTarget(candidates);
        if (!decision) {
            await this.memoryStore.addPendingUpdate({
                transition: "reopen_failure",
                eventType: "reopen_failure",
                targetCandidates: candidates.map((candidate) => ({
                    nodeId: candidate.node.nodeId,
                    score: candidate.score,
                    reason: candidate.matchedAnchors.join(", "),
                })),
                toStatus: "active",
                confidence: estimateAmbiguousConfidence(candidates),
                reason: "ambiguous resolved failure candidates for recurrence",
                evidenceMessageId: input.evidenceMessageId,
                metadata: {
                    newFailureNodeId: input.newFailureNodeId,
                    files: input.files ?? [],
                    commands: input.commands ?? [],
                    signatures: input.signatures ?? [],
                },
            });
            return {
                action: "pending",
                transition: "reopen_failure",
                targetNodeIds: candidates.map((candidate) => candidate.node.nodeId),
                confidence: estimateAmbiguousConfidence(candidates),
                reason: "ambiguous resolved failure candidates for recurrence",
            };
        }
        await this.applyFailureReopen(decision.node, decision.confidence, reason, input);
        return {
            action: "applied",
            transition: "reopen_failure",
            targetNodeIds: [decision.node.nodeId],
            confidence: decision.confidence,
            reason,
        };
    }
    async reopenResolvedFailuresForFixAttempt(input) {
        const relations = await this.memoryStore.getRelationsForNode(input.fixAttemptNodeId, "from");
        const resolvedFailures = [];
        for (const relation of relations) {
            if (relation.relationType !== "resolves")
                continue;
            const node = await this.memoryStore.getNode(relation.toNodeId);
            if (node?.kind === "failure" && node.status === "resolved") {
                resolvedFailures.push(node);
            }
        }
        if (resolvedFailures.length === 0) {
            return {
                action: "none",
                transition: "reopen_failure",
                targetNodeIds: [],
                confidence: 0,
                reason: "fix attempt has no resolved failure relations to reopen",
            };
        }
        const reason = input.reason ??
            "fix attempt became partial or failed after additional validation";
        for (const node of resolvedFailures) {
            await this.applyFailureReopen(node, 0.9, reason, {
                evidenceMessageId: input.evidenceMessageId,
            });
        }
        return {
            action: "applied",
            transition: "reopen_failure",
            targetNodeIds: resolvedFailures.map((node) => node.nodeId),
            confidence: 0.9,
            reason,
        };
    }
    async resolveNode(input) {
        const node = await this.memoryStore.getNode(input.nodeId);
        if (!node) {
            return {
                action: "none",
                transition: "resolve_node",
                targetNodeIds: [],
                confidence: 0,
                reason: `node ${input.nodeId} not found`,
            };
        }
        if (node.kind !== "task" && node.kind !== "constraint") {
            return {
                action: "none",
                transition: "resolve_node",
                targetNodeIds: [],
                confidence: 0,
                reason: `node ${node.nodeId} kind ${node.kind} does not support resolve_node`,
            };
        }
        if (node.status === "resolved") {
            return {
                action: "none",
                transition: "resolve_node",
                targetNodeIds: [node.nodeId],
                confidence: 1,
                reason: `${node.kind} is already resolved`,
            };
        }
        if (node.status === "superseded") {
            return {
                action: "none",
                transition: "resolve_node",
                targetNodeIds: [node.nodeId],
                confidence: 1,
                reason: `${node.kind} is superseded; resolve the current replacement instead`,
            };
        }
        if (node.status === "stale") {
            return {
                action: "none",
                transition: "resolve_node",
                targetNodeIds: [node.nodeId],
                confidence: 1,
                reason: `${node.kind} is stale`,
            };
        }
        const reason = input.reason ??
            (node.kind === "task"
                ? "task completed and is no longer active"
                : "constraint is no longer active for the current work");
        const now = new Date().toISOString();
        await this.memoryStore.updateNodeStatus({
            nodeId: node.nodeId,
            toStatus: "resolved",
            eventType: node.kind === "task" ? "resolve_task" : "resolve_constraint",
            confidence: 0.95,
            reason,
            evidenceMessageId: input.evidenceMessageId,
            metadata: {
                resolved: true,
                resolution: reason,
                resolvedAt: now,
            },
            lifecycle: {
                resolvedAt: now,
                resolvedReason: reason,
            },
        });
        return {
            action: "applied",
            transition: "resolve_node",
            targetNodeIds: [node.nodeId],
            confidence: 0.95,
            reason,
        };
    }
    async supersedeNode(input) {
        const [oldNode, newNode] = await Promise.all([
            this.memoryStore.getNode(input.oldNodeId),
            this.memoryStore.getNode(input.newNodeId),
        ]);
        if (!oldNode || !newNode) {
            return {
                action: "none",
                transition: "supersede_node",
                targetNodeIds: [],
                confidence: 0,
                reason: "oldNodeId or newNodeId was not found",
            };
        }
        if (oldNode.kind !== newNode.kind) {
            return {
                action: "none",
                transition: "supersede_node",
                targetNodeIds: [oldNode.nodeId, newNode.nodeId],
                confidence: 0,
                reason: "old and new nodes must share the same kind to supersede",
            };
        }
        if (oldNode.kind !== "decision" &&
            oldNode.kind !== "task" &&
            oldNode.kind !== "constraint") {
            return {
                action: "none",
                transition: "supersede_node",
                targetNodeIds: [oldNode.nodeId, newNode.nodeId],
                confidence: 0,
                reason: `kind ${oldNode.kind} does not support supersede_node`,
            };
        }
        const ok = await this.memoryStore.supersedeNode({
            oldNodeId: oldNode.nodeId,
            newNodeId: newNode.nodeId,
            reason: input.reason ??
                `${oldNode.kind} ${oldNode.nodeId} superseded by ${newNode.nodeId}`,
            evidenceMessageId: input.evidenceMessageId,
            metadata: { lifecycleResolver: true },
        });
        return {
            action: ok ? "applied" : "none",
            transition: "supersede_node",
            targetNodeIds: ok ? [oldNode.nodeId, newNode.nodeId] : [],
            confidence: ok ? 1 : 0,
            reason: ok
                ? input.reason ?? `${oldNode.kind} superseded`
                : `could not supersede ${oldNode.kind} node`,
        };
    }
    async markNodeStale(input) {
        return this.markStale(input, "stale_node", "stale_node");
    }
    async markSummaryStale(input) {
        return this.markStale(input, "stale_summary", "stale_summary");
    }
    async markStale(input, transition, eventType) {
        const node = await this.memoryStore.getNode(input.nodeId);
        if (!node) {
            return {
                action: "none",
                transition,
                targetNodeIds: [],
                confidence: 0,
                reason: `node ${input.nodeId} not found`,
            };
        }
        if (node.status === "stale") {
            return {
                action: "none",
                transition,
                targetNodeIds: [node.nodeId],
                confidence: 1,
                reason: "node is already stale",
            };
        }
        const reason = input.reason ?? "marked stale by lifecycle resolver";
        await this.memoryStore.updateNodeStatus({
            nodeId: node.nodeId,
            toStatus: "stale",
            eventType,
            confidence: 0.9,
            reason,
            evidenceMessageId: input.evidenceMessageId,
            evidenceSummaryId: input.evidenceSummaryId,
            metadata: {
                stale: true,
                staleReason: reason,
            },
            lifecycle: {
                staleReason: reason,
            },
        });
        return {
            action: "applied",
            transition,
            targetNodeIds: [node.nodeId],
            confidence: 0.9,
            reason,
        };
    }
    async applyFailureReopen(node, confidence, reason, input) {
        const fromStatus = node.status;
        await this.memoryStore.updateNodeStatus({
            nodeId: node.nodeId,
            toStatus: "active",
            eventType: "reopen_failure",
            confidence,
            reason,
            evidenceMessageId: input.evidenceMessageId,
            metadata: {
                reopened: true,
                reopenReason: reason,
                newFailureNodeId: input.newFailureNodeId,
            },
            lifecycle: {
                reopenedFromStatus: fromStatus,
                newFailureNodeId: input.newFailureNodeId,
            },
        });
        if (input.newFailureNodeId && input.newFailureNodeId !== node.nodeId) {
            await this.memoryStore.addRelation({
                fromNodeId: input.newFailureNodeId,
                toNodeId: node.nodeId,
                relationType: "relatedTo",
                confidence,
                evidenceMessageId: input.evidenceMessageId,
                metadata: {
                    relationReason: "recurrence reopened prior failure",
                },
            });
        }
    }
}
function chooseStrongFailureTarget(candidates) {
    if (candidates.length === 0)
        return null;
    const [top, second] = candidates;
    const hasStrongScore = top.score >= 3.5;
    const isClearWinner = !second || top.score - second.score >= 1.25;
    if (!hasStrongScore || !isClearWinner)
        return null;
    return {
        ...top,
        confidence: Math.min(0.95, 0.82 + top.score / 20),
    };
}
function estimateAmbiguousConfidence(candidates) {
    if (candidates.length === 0)
        return 0;
    const top = candidates[0];
    const second = candidates[1];
    if (!second)
        return Math.min(0.75, top.score / 10);
    return Math.max(0.6, Math.min(0.8, (top.score - second.score + 3) / 8));
}
//# sourceMappingURL=lifecycle-resolver.js.map
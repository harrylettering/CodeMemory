import { describe, expect, it } from "vitest";

import { createFastRetrievalPlan } from "../src/retrieval-plan.js";
import {
  decideSmartPlanning,
  SmartQueryPlanner,
} from "../src/query-planner.js";

describe("Smart query planner", () => {
  it("does not trigger when disabled", () => {
    const fastPlan = createFastRetrievalPlan("之前我们为什么这么决定");
    const decision = decideSmartPlanning({
      enabled: false,
      prompt: "之前我们为什么这么决定",
      fastPlan,
      memoryNodes: [],
    });

    expect(decision.shouldPlan).toBe(false);
    expect(decision.reason).toBe("disabled");
  });

  it("triggers for a history prompt with no fast memory hits", () => {
    const fastPlan = createFastRetrievalPlan("之前我们为什么这么决定");
    const decision = decideSmartPlanning({
      enabled: true,
      prompt: "之前我们为什么这么决定",
      fastPlan,
      memoryNodes: [],
    });

    expect(decision.shouldPlan).toBe(true);
    expect(decision.reason).toBe("no_fast_memory_hits");
  });

  it("coerces valid planner JSON into a RetrievalPlan", async () => {
    const fastPlan = createFastRetrievalPlan("之前我们为什么这么决定");
    const planner = new SmartQueryPlanner(
      {
        queryPlannerModel: undefined,
        queryPlannerTimeoutMs: 1200,
        queryPlannerMaxTokens: 800,
      },
      async () =>
        JSON.stringify({
          intent: "recall_decision_rationale",
          riskLevel: "medium",
          entities: {
            files: [],
            commands: [],
            symbols: [],
            packages: [],
            topics: ["validation"],
          },
          wantedKinds: ["decision", "summary_anchor"],
          queryVariants: ["validation decision"],
          tagQueries: [
            { tagType: "topic", tagValue: "validation", weight: 2 },
          ],
          recallPolicy: {
            maxCandidates: 12,
            maxInjectedItems: 4,
            tokenBudget: 900,
            expandSummaries: true,
            maxSummaryDepth: 1,
            minScore: 0.4,
          },
        })
    );

    const plan = await planner.plan({
      prompt: "之前我们为什么这么决定",
      fastPlan,
      reason: "no_fast_memory_hits",
    });

    expect(plan.intent).toBe("recall_decision_rationale");
    expect(plan.entities.topics).toContain("validation");
    expect(plan.wantedKinds).toEqual(
      expect.arrayContaining(["task", "constraint", "decision", "summary_anchor"])
    );
    expect(plan.tagQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "topic", tagValue: "validation" }),
      ])
    );
    expect(plan.recallPolicy.maxCandidates).toBe(12);
  });

  it("rejects invalid planner output so callers can fallback", async () => {
    const fastPlan = createFastRetrievalPlan("之前我们为什么这么决定");
    const planner = new SmartQueryPlanner(
      {
        queryPlannerModel: undefined,
        queryPlannerTimeoutMs: 1200,
        queryPlannerMaxTokens: 800,
      },
      async () => "not json"
    );

    await expect(
      planner.plan({
        prompt: "之前我们为什么这么决定",
        fastPlan,
        reason: "no_fast_memory_hits",
      })
    ).rejects.toThrow(/json/i);
  });
});

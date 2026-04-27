import { describe, expect, it } from "vitest";

import {
  createFastRetrievalPlan,
  extractPromptPivots,
} from "../src/retrieval-plan.js";

describe("createFastRetrievalPlan", () => {
  it("turns a Chinese prompt into file/command/topic tag queries", () => {
    const plan = createFastRetrievalPlan(
      "请修改 src/auth/login.ts, 然后重新跑 npm test, 之前这里好像失败过"
    );

    expect(plan.intent).toBe("modify_and_avoid_prior_failure");
    expect(plan.riskLevel).toBe("high");
    expect(plan.entities.files).toContain("src/auth/login.ts");
    expect(plan.entities.commands.some((cmd) => cmd.startsWith("npm test"))).toBe(true);
    expect(plan.entities.topics).toContain("auth");
    expect(plan.entities.topics).toContain("test");
    expect(plan.wantedKinds).toContain("task");
    expect(plan.wantedKinds).toContain("constraint");
    expect(plan.wantedKinds).toContain("failure");
    expect(plan.wantedKinds).toContain("decision");
    expect(plan.wantedKinds).toContain("summary_anchor");
    expect(plan.tagQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tagType: "file",
          tagValue: expect.stringMatching(/^[0-9a-f]{8}:src\/auth\/login\.ts$/),
        }),
        expect.objectContaining({ tagType: "command", tagValue: "npm test" }),
      ])
    );
  });

  it("extracts useful Chinese keywords without relying on \\w tokenization", () => {
    const pivots = extractPromptPivots("分析召回准确率和摘要检索失败的问题");

    expect(pivots.keywords).toEqual(
      expect.arrayContaining(["召回", "准确率", "摘要", "检索", "失败"])
    );
  });

  it("keeps task / constraint recall on low-anchor continuation prompts", () => {
    const plan = createFastRetrievalPlan("继续下一步");

    expect(plan.intent).toBe("general_context_lookup");
    expect(plan.wantedKinds).toEqual(
      expect.arrayContaining(["task", "constraint", "summary_anchor"])
    );
    expect(plan.tagQueries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tagType: "kind", tagValue: "task" }),
        expect.objectContaining({ tagType: "kind", tagValue: "constraint" }),
      ])
    );
  });

  it("does not treat file extensions as standalone commands", () => {
    const pivots = extractPromptPivots("go build /tmp/demo/main.go 失败了");

    expect(pivots.filePaths).toContain("/tmp/demo/main.go");
    expect(pivots.commands).toEqual(["go build"]);
  });
});

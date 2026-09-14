import { describe, expect, it } from "vitest";

import { resolveCodeMemoryConfig } from "../src/db/config.js";
import { buildClaudeCliArgs } from "../src/llm/claude-cli.js";

describe("resolveCodeMemoryConfig", () => {
  it("leaves every model setting unset by default", () => {
    const config = resolveCodeMemoryConfig({} as NodeJS.ProcessEnv);

    // Unset, not a pinned id. A default here silently overrode whatever model
    // the host was configured for, and a pinned id also rots: it names one
    // release that eventually stops being the right answer.
    expect(config.expansionModel).toBeUndefined();
    expect(config.queryPlannerModel).toBeUndefined();
    expect(config.compactionModel).toBeUndefined();
    expect(config.autoSupersedeModel).toBeUndefined();
  });

  it("treats an empty string as unset rather than as a model named ''", () => {
    const config = resolveCodeMemoryConfig({
      CODEMEMORY_COMPACTION_MODEL: "",
    } as NodeJS.ProcessEnv);

    expect(config.compactionModel).toBeUndefined();
  });

  it("does not let one model env var override another", () => {
    const config = resolveCodeMemoryConfig({
      CODEMEMORY_EXPANSION_MODEL: "expansion-only-model",
      CODEMEMORY_COMPACTION_MODEL: "compaction-only-model",
    } as NodeJS.ProcessEnv);

    expect(config.expansionModel).toBe("expansion-only-model");
    expect(config.compactionModel).toBe("compaction-only-model");
    expect(config.queryPlannerModel).toBeUndefined();
    expect(config.autoSupersedeModel).toBeUndefined();
  });
});

describe("buildClaudeCliArgs", () => {
  it("omits --model entirely when no model is configured", () => {
    const args = buildClaudeCliArgs(undefined);
    expect(args).not.toContain("--model");
    expect(args).toEqual([
      "--print",
      "--output-format",
      "text",
      "--no-session-persistence",
    ]);
  });

  it("omits --model for an empty string, which is not a model name", () => {
    expect(buildClaudeCliArgs("")).not.toContain("--model");
  });

  it("passes a configured model through", () => {
    const args = buildClaudeCliArgs("claude-haiku-4-5-20251001");
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("claude-haiku-4-5-20251001");
  });
});

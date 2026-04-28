import { describe, expect, it } from "vitest";

import {
  DEFAULT_CODEMEMORY_MODEL,
  resolveCodeMemoryConfig,
} from "../src/db/config.js";

describe("resolveCodeMemoryConfig", () => {
  it("defaults each model setting independently", () => {
    const config = resolveCodeMemoryConfig({} as NodeJS.ProcessEnv);

    expect(config.expansionModel).toBe(DEFAULT_CODEMEMORY_MODEL);
    expect(config.queryPlannerModel).toBe(DEFAULT_CODEMEMORY_MODEL);
    expect(config.compactionModel).toBe(DEFAULT_CODEMEMORY_MODEL);
    expect(config.autoSupersedeModel).toBe(DEFAULT_CODEMEMORY_MODEL);
  });

  it("does not let one model env var override another", () => {
    const config = resolveCodeMemoryConfig({
      CODEMEMORY_EXPANSION_MODEL: "expansion-only-model",
      CODEMEMORY_COMPACTION_MODEL: "compaction-only-model",
    } as NodeJS.ProcessEnv);

    expect(config.expansionModel).toBe("expansion-only-model");
    expect(config.compactionModel).toBe("compaction-only-model");
    expect(config.queryPlannerModel).toBe(DEFAULT_CODEMEMORY_MODEL);
    expect(config.autoSupersedeModel).toBe(DEFAULT_CODEMEMORY_MODEL);
  });
});

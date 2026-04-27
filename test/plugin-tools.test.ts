import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import createCodeMemoryPlugin from "../src/plugin/index.js";

let dbDir: string;
let originalDbEnv: string | undefined;
let originalDebugToolsEnv: string | undefined;

const DEPS = {
  config: {} as any,
  complete: async () => ({ content: [] }),
  log: { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} },
};

beforeEach(() => {
  dbDir = mkdtempSync(join(tmpdir(), "codememory-plugin-"));
  originalDbEnv = process.env.CODEMEMORY_DATABASE_PATH;
  originalDebugToolsEnv = process.env.CODEMEMORY_DEBUG_TOOLS_ENABLED;
  process.env.CODEMEMORY_DATABASE_PATH = join(dbDir, "codememory.db");
  delete process.env.CODEMEMORY_DEBUG_TOOLS_ENABLED;
});

afterEach(() => {
  if (originalDbEnv === undefined) delete process.env.CODEMEMORY_DATABASE_PATH;
  else process.env.CODEMEMORY_DATABASE_PATH = originalDbEnv;
  if (originalDebugToolsEnv === undefined) delete process.env.CODEMEMORY_DEBUG_TOOLS_ENABLED;
  else process.env.CODEMEMORY_DEBUG_TOOLS_ENABLED = originalDebugToolsEnv;
  rmSync(dbDir, { recursive: true, force: true });
});

describe("plugin tool exposure", () => {
  it("hides low-level debug retrieval tools by default", async () => {
    const activated = await createCodeMemoryPlugin().activate(DEPS as any);
    try {
      const names = activated.tools.map((tool: any) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "codememory_check_prior_failures",
          "codememory_mark_decision",
          "codememory_mark_requirement",
          "codememory_compact",
        ])
      );
      expect(names).not.toContain("codememory_grep");
      expect(names).not.toContain("codememory_describe");
      expect(names).not.toContain("codememory_expand");
      expect(names).not.toContain("codememory_expand_query");
      expect(names).not.toContain("codememory_memory_pending");
      expect(names).not.toContain("codememory_memory_lifecycle");
    } finally {
      await (activated.engine as any).db.close();
    }
  });

  it("exposes debug retrieval tools when enabled", async () => {
    process.env.CODEMEMORY_DEBUG_TOOLS_ENABLED = "true";

    const activated = await createCodeMemoryPlugin().activate(DEPS as any);
    try {
      const names = activated.tools.map((tool: any) => tool.name);
      expect(names).toEqual(
        expect.arrayContaining([
          "codememory_grep",
          "codememory_describe",
          "codememory_expand",
          "codememory_expand_query",
          "codememory_memory_pending",
          "codememory_memory_lifecycle",
        ])
      );
    } finally {
      await (activated.engine as any).db.close();
    }
  });
});

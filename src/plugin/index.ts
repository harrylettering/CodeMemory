/**
 * CodeMemory for Claude Code - Plugin Entry Point
 *
 * CodeMemory plugin for Claude Code CLI.
 *
 * DAG-based conversation summarization with incremental compaction,
 * full-text search, and sub-agent expansion.
 */

import type { CodeMemoryDependencies } from "../types.js";
import { resolveCodeMemoryConfig } from "../db/config.js";
import { createCodeMemoryDatabaseConnection } from "../db/connection.js";
import { CodeMemoryContextEngine } from "../engine.js";
import { createCodeMemoryGrepTool } from "../tools/codememory-grep-tool.js";
import { createCodeMemoryDescribeTool } from "../tools/codememory-describe-tool.js";
import { createCodeMemoryExpandTool } from "../tools/codememory-expand-tool.js";
import { createCodeMemoryExpandQueryTool } from "../tools/codememory-expand-query-tool.js";
import { createCodeMemoryCheckPriorFailuresTool } from "../tools/codememory-check-prior-failures-tool.js";
import { createCodeMemoryMarkDecisionTool } from "../tools/codememory-mark-decision-tool.js";
import { createCodeMemoryMarkRequirementTool } from "../tools/codememory-mark-requirement-tool.js";
import { createCodeMemoryCompactTool } from "../tools/codememory-compact-tool.js";
import { createCodeMemoryMemoryPendingTool } from "../tools/codememory-memory-pending-tool.js";
import { createCodeMemoryMemoryLifecycleTool } from "../tools/codememory-memory-lifecycle-tool.js";
import { createMemoryNodeStore } from "../store/memory-store.js";
import { LifecycleResolver } from "../lifecycle-resolver.js";

export default function createCodeMemoryPlugin() {
  return {
    name: "codememory",
    description: "CodeMemory for Claude Code CLI",

    async initialize() {
      console.log("[codememory] CodeMemory for Claude Code initialized");
    },

    async activate(deps: CodeMemoryDependencies) {
      const config = resolveCodeMemoryConfig();

      const db = await createCodeMemoryDatabaseConnection(config.databasePath);

      const engine = new CodeMemoryContextEngine({
        db,
        config,
        deps,
      });

      const memoryStore = createMemoryNodeStore(db);
      const lifecycleResolver = new LifecycleResolver(memoryStore);

      // The current sessionId isn't known until a hook fires; the
      // plugin host stamps it on `deps` per-call. We capture-by-closure
      // so the decision tool always reads the freshest value.
      const getCurrentSessionId = (): string | undefined => {
        const sid = (deps as any)?.sessionId ?? (deps as any)?.session_id;
        return typeof sid === "string" && sid.length > 0 ? sid : undefined;
      };

      const tools: any[] = [
        await createCodeMemoryCheckPriorFailuresTool(memoryStore),
        await createCodeMemoryMarkDecisionTool(
          engine.getConversationStore(),
          getCurrentSessionId,
          memoryStore
        ),
        await createCodeMemoryMarkRequirementTool(
          engine.getConversationStore(),
          getCurrentSessionId,
          memoryStore
        ),
        await createCodeMemoryCompactTool(engine, getCurrentSessionId),
      ];

      if (config.debugToolsEnabled) {
        tools.push(
          await createCodeMemoryGrepTool(
            engine.getConversationStore(),
            engine.getSummaryStore(),
            deps
          ),
          await createCodeMemoryDescribeTool(
            engine.getConversationStore(),
            engine.getSummaryStore(),
            deps
          ),
          await createCodeMemoryExpandTool(
            engine.getConversationStore(),
            engine.getSummaryStore(),
            deps
          ),
          await createCodeMemoryExpandQueryTool(
            engine.getConversationStore(),
            engine.getSummaryStore(),
            deps
          ),
          await createCodeMemoryMemoryPendingTool(memoryStore),
          await createCodeMemoryMemoryLifecycleTool(memoryStore, lifecycleResolver)
        );
      }

      return { engine, tools };
    },
  };
}

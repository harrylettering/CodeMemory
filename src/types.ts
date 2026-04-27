/**
 * CodeMemory for Claude Code - Core Type Definitions
 *
 * These types define the contracts between CodeMemory and Claude Code core,
 * abstracting away direct imports from core internals.
 */

import type { CodeMemoryConfig } from "./db/config.js";

/**
 * Minimal LLM completion interface needed by CodeMemory for summarization.
 * Matches the signature of completeSimple from Claude Code API.
 */
export type CompletionContentBlock = {
  type: string;
  text?: string;
  [key: string]: unknown;
};

export type CompletionErrorInfo = {
  kind?: string;
  message?: string;
  code?: string;
  statusCode?: number;
  [key: string]: unknown;
};

export type CompletionResult = {
  content: CompletionContentBlock[];
  error?: CompletionErrorInfo;
  [key: string]: unknown;
};

export type CompleteFn = (params: {
  provider?: string;
  model: string;
  apiKey?: string;
  providerApi?: string;
  authProfileId?: string;
  agentDir?: string;
  runtimeConfig?: unknown;
  messages: Array<{ role: string; content: unknown }>;
  system?: string;
  maxTokens: number;
  temperature?: number;
  reasoning?: string;
}) => Promise<CompletionResult>;

/**
 * Dependencies injected into the CodeMemory engine at registration time.
 *
 * Kept minimal on purpose: earlier iterations carried 12+ fields for
 * subagent/gateway/session-key machinery that the v2 engine (daemon +
 * socket architecture) no longer uses. Only fields read by live code
 * belong here — extending this shape re-introduces coupling we already
 * paid to remove.
 */
export interface CodeMemoryDependencies {
  /** CodeMemory configuration (from env vars + plugin config) */
  config: CodeMemoryConfig;

  /** LLM completion function — used by codememory_expand_query for context synthesis. */
  complete: CompleteFn;

  /** Logger */
  log: {
    info: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    debug: (msg: string) => void;
  };
}

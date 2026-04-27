/**
 * Unit tests for Filter/Score #3 — DECISION_PATTERNS tightening and the
 * new keyword+length joint gate.
 *
 * Structure:
 *   - "no longer promotes to S" — bare connective words that used to
 *     false-positive (`because`, `原因`, `应该`, etc.) now stay at M
 *   - "still promotes to S" — explicit decision / fix / diagnosis phrases
 *     still get picked up when the text is substantive (>= 30 chars)
 *   - "length gate" — a keyword match on a very short text stays M
 */

import { describe, expect, it, beforeEach } from "vitest";
import {
  scoreMessage,
  createSessionState,
  type ScorerSessionState,
} from "../src/filter/scorer.js";
import type { JsonlMessage, RawMessagePart } from "../src/hooks/jsonl-watcher.js";

let state: ScorerSessionState;

beforeEach(() => {
  state = createSessionState();
});

// Assistant text-only messages — the path that DECISION_PATTERNS gates.
// We wrap in a short text <200 chars so only the decision-keyword path
// (not the long-form path) can promote to S.
function assistantText(text: string): JsonlMessage {
  const parts: RawMessagePart[] = [{ type: "text", text }];
  return {
    id: `a-${Math.random()}`,
    type: "assistant",
    role: "assistant",
    content: text,
    timestamp: Date.now(),
    metadata: { sessionId: "s", parts },
  };
}

describe("DECISION_PATTERNS false-positive fixes", () => {
  const falsePositives: Array<[string, string]> = [
    [
      "bare 'because' in prose",
      "I read this file because you asked me to check it.",
    ],
    [
      "bare 'instead of' in prose",
      "We could use Redis instead of Memcached here, but both work.",
    ],
    [
      "bare 中文 '因为' in prose",
      "我看了一下这个文件，因为你让我检查一下。",
    ],
    [
      "bare 中文 '原因' in prose",
      "原因之一是配置文件的路径不对，另外是权限问题也要看看。",
    ],
    [
      "bare 中文 '应该' in prose",
      "我觉得这里应该先看看再说，不太确定具体要改什么地方。",
    ],
    [
      "'to fix' as generic infinitive",
      "Now I'll try to fix the layout a little and see what happens next.",
    ],
    [
      "'the fix' as trailing noun, not assertion",
      "Yeah, the fix you pushed looks reasonable to me for now.",
    ],
  ];

  for (const [name, text] of falsePositives) {
    it(`no longer promotes to S: ${name}`, () => {
      const result = scoreMessage(assistantText(text), state);
      expect(result.tier, `text: ${text}`).toBe("M");
    });
  }
});

describe("DECISION_PATTERNS still catches real decisions", () => {
  const realDecisions: Array<[string, string]> = [
    [
      "'decided to' explicit choice",
      "I decided to rewrite the auth middleware after seeing the race.",
    ],
    [
      "'chose X over Y'",
      "I chose Redis over Memcached for persistence across restarts.",
    ],
    [
      "'going with' explicit pivot",
      "Going with a polling loop here — subscriptions add too much surface.",
    ],
    [
      "'switched from X to Y'",
      "Switched from bcrypt to argon2 because of the new policy review.",
    ],
    [
      "'rolled back' statement",
      "Rolled back the migration — the index was blocking writes in prod.",
    ],
    [
      "'root cause' identification",
      "Root cause: we were reusing the connection across event loop ticks.",
    ],
    [
      "'caused by' frame",
      "The timeout was caused by a stuck DNS lookup inside the resolver.",
    ],
    [
      "'the issue is' diagnosis",
      "The issue is that the hook fires before the parent is fully bound.",
    ],
    [
      "'the fix is' assertion",
      "The fix is adding a retry with exponential backoff on transient errors.",
    ],
    [
      "line-start 'fix:' label",
      "fix: guard the null case in renderInput before touching props.",
    ],
    [
      "中文 '我决定' explicit choice",
      "我决定把这个模块重写一遍，老代码里的锁逻辑已经没法再 patch 了。",
    ],
    [
      "中文 '最终采用'",
      "最终采用 Redis 方案，因为需要跨进程共享状态并且要做持久化。",
    ],
    [
      "中文 '根本原因'",
      "根本原因是缓存没有清掉，所以老的 session token 又被当成有效的了。",
    ],
    [
      "中文 '问题在于'",
      "问题在于 path 解析的时候没有 normalize，导致拼接后出现双斜杠。",
    ],
    [
      "中文 '已修复'",
      "已修复：增加了一次重试并且把超时从 5 秒改成了 15 秒再观察。",
    ],
    [
      "中文 '通过X修复'",
      "通过在入口处加一个锁来修复了并发写入导致的数据错乱问题。",
    ],
  ];

  for (const [name, text] of realDecisions) {
    it(`still promotes to S: ${name}`, () => {
      const result = scoreMessage(assistantText(text), state);
      expect(result.tier, `text: ${text}`).toBe("S");
      expect(result.tags, `text: ${text}`).toContain("decision");
    });
  }
});

describe("DECISION length gate — short keyword hits stay M", () => {
  const shortHits: Array<[string, string]> = [
    ["'修复：是的' (7 chars)", "修复：是的"],
    ["'fix: ok' (7 chars)", "fix: ok"],
    ["'the fix is X' (14 chars)", "the fix is x."],
    ["'我决定了' (4 chars)", "我决定了"],
    ["'总结：有' (5 chars)", "总结：有"],
    ["'说明：' + short (10 chars)", "说明：见下。"],
  ];

  for (const [name, text] of shortHits) {
    it(`stays at M: ${name}`, () => {
      const result = scoreMessage(assistantText(text), state);
      expect(result.tier, `text: ${text}`).toBe("M");
      expect(result.tags, `text: ${text}`).not.toContain("decision");
    });
  }
});

describe("Long-form path still works independently of decisions", () => {
  it(">= 500 chars + structure signal promotes via assistant_longform", () => {
    // 500+ chars with a fenced code block (structure signal)
    const longText = "a".repeat(500) + "\n```\nsome code\n```\n";
    const result = scoreMessage(assistantText(longText), state);
    expect(result.tier).toBe("S");
    expect(result.tags).toContain("assistant_longform");
    expect(result.tags).not.toContain("decision");
  });
});

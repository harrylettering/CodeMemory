#!/usr/bin/env node
/**
 * PreToolUse Lookup Latency Benchmark
 *
 * Measures the performance of the prior-failure lookup pipeline to verify
 * the p95 < 200ms performance target. Supports both in-memory direct
 * testing and full daemon socket testing.
 */
import { performance } from "node:perf_hooks";
import { createCodeMemoryDatabaseConnection } from "../dist/db/connection.js";
import { createMemoryNodeStore } from "../dist/store/memory-store.js";
import { lookupForPreToolUse } from "../dist/failure-lookup.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
// Benchmark configuration
interface BenchmarkConfig {
  iterations: number;
  warmupIterations: number;
  mode: "in-memory" | "daemon";
  queryType: "file" | "command" | "symbol" | "mixed";
  socketPath?: string;
  /** When true, exit 1 if any percentile exceeds its threshold. */
  ci: boolean;
  thresholdP95Ms: number;
  thresholdP99Ms: number;
}
const DEFAULT_CONFIG: BenchmarkConfig = {
  iterations: 10000,
  warmupIterations: 1000,
  mode: "in-memory",
  queryType: "mixed",
  ci: false,
  thresholdP95Ms: 200,
  thresholdP99Ms: 500,
};
// CI mode runs a much smaller load — designed to finish in a few seconds so it
// can sit in a PR pipeline without bloating wall time. Numbers tuned to keep
// p95 stable enough for a regression gate without burning >10s.
const CI_ITERATIONS = 1000;
const CI_WARMUP = 200;
// Test data - realistic file paths, commands, and errors
const TEST_FILE_PATHS = [
  "/repo/src/auth/login.ts",
  "/repo/src/user/profile.ts",
  "/repo/src/payment/processor.ts",
  "/repo/src/api/routes.ts",
  "/repo/src/db/connection.ts",
  "/repo/src/utils/validation.ts",
];
const TEST_COMMANDS = [
  "npm test",
  "npm run build",
  "tsc --noEmit",
  "vitest run",
  "docker compose up",
  "git push origin main",
];
const TEST_SYMBOLS = [
  "handleLogin",
  "processPayment",
  "validateUserInput",
  "getUserProfile",
  "executeQuery",
  "formatResponse",
];
const TYPES = ["test_fail", "type_error", "lint_error", "runtime_error", "bash_nonzero"] as const;
// Seed realistic failure-node records into the memory store.
async function seedFailures(db: any, store: any, count: number) {
  // Spread across multiple conversations so the seed mirrors a long-lived DB.
  const seenConversations = new Set<number>();
  for (let i = 0; i < count; i++) {
    const conversationId = Math.floor(i / 10) + 1;
    if (!seenConversations.has(conversationId)) {
      await db.run(
        `INSERT OR IGNORE INTO conversations (conversationId, sessionId) VALUES (?, ?)`,
        [conversationId, `session-${Math.floor(i / 100)}`]
      );
      seenConversations.add(conversationId);
    }
    const filePath = TEST_FILE_PATHS[i % TEST_FILE_PATHS.length];
    const command = TEST_COMMANDS[i % TEST_COMMANDS.length];
    const symbol = TEST_SYMBOLS[i % TEST_SYMBOLS.length];
    await store.createFailureNode({
      conversationId,
      sessionId: `session-${Math.floor(i / 100)}`,
      seq: i % 100,
      type: TYPES[i % TYPES.length],
      signature: `error-signature-${i}`,
      raw: `Error: Test error ${i} in ${filePath} at line ${100 + i}`,
      filePath,
      command,
      symbol,
      attemptedFix: `Attempted to fix ${i}`,
      messageId: `msg-${i}`,
      weight: 1.0,
    });
  }
}
// Helper to calculate percentiles
function calculatePercentiles(latencies: number[], percentiles: number[]): Record<number, number> {
  const sorted = [...latencies].sort((a, b) => a - b);
  const result: Record<number, number> = {};
  for (const p of percentiles) {
    const index = Math.ceil((p / 100) * sorted.length) - 1;
    result[p] = Math.round(sorted[Math.max(0, Math.min(index, sorted.length - 1))] * 100) / 100;
  }
  return result;
}
// In-memory benchmark runner
async function runInMemoryBenchmark(config: BenchmarkConfig) {
  console.log("\n🚀 Running in-memory benchmark...");
  // Create temporary database
  const tempDir = mkdtempSync(join(tmpdir(), "codememory-benchmark-"));
  const dbPath = join(tempDir, "benchmark.db");
  try {
    const db = await createCodeMemoryDatabaseConnection(dbPath);
    const memoryStore = createMemoryNodeStore(db);
    // Seed test data
    console.log("Seeding 1000 test failure-node records...");
    await seedFailures(db, memoryStore, 1000);
    // Generate test queries
    const queries = [];
    for (let i = 0; i < config.iterations + config.warmupIterations; i++) {
      let toolName: string, toolInput: any;
      if (config.queryType === "file" || (config.queryType === "mixed" && Math.random() < 0.4)) {
        toolName = "Edit";
        toolInput = { file_path: TEST_FILE_PATHS[i % TEST_FILE_PATHS.length] };
      } else if (config.queryType === "command" || (config.queryType === "mixed" && Math.random() < 0.7)) {
        toolName = "Bash";
        toolInput = { command: TEST_COMMANDS[i % TEST_COMMANDS.length] };
      } else {
        toolName = "Edit";
        toolInput = { file_path: TEST_FILE_PATHS[i % TEST_FILE_PATHS.length] };
      }
      queries.push({ toolName, toolInput });
    }
    // Warmup
    console.log(`Warming up with ${config.warmupIterations} iterations...`);
    for (let i = 0; i < config.warmupIterations; i++) {
      const { toolName, toolInput } = queries[i];
      await lookupForPreToolUse(memoryStore, toolName, toolInput);
    }
    // Run benchmark
    console.log(`Running ${config.iterations} benchmark iterations...`);
    const latencies: number[] = [];
    const startTotal = performance.now();
    for (let i = config.warmupIterations; i < queries.length; i++) {
      const { toolName, toolInput } = queries[i];
      const start = performance.now();
      await lookupForPreToolUse(memoryStore, toolName, toolInput);
      const end = performance.now();
      latencies.push(end - start);
    }
    const endTotal = performance.now();
    // Calculate results
    const totalTime = endTotal - startTotal;
    const throughput = config.iterations / (totalTime / 1000);
    const percentiles = calculatePercentiles(latencies, [50, 95, 99]);
    // Print report
    console.log("\n📊 Benchmark Results");
    console.log("=".repeat(50));
    console.log(`Mode:        In-memory (direct function call)`);
    console.log(`Iterations:  ${config.iterations.toLocaleString()}`);
    console.log(`Query type:  ${config.queryType}`);
    console.log(`Total time:  ${Math.round(totalTime)}ms`);
    console.log(`Throughput:  ${Math.round(throughput).toLocaleString()} req/sec`);
    const p95Pass = percentiles[95] < config.thresholdP95Ms;
    const p99Pass = percentiles[99] < config.thresholdP99Ms;
    console.log("\nLatency percentiles:");
    console.log(`  p50:  ${percentiles[50]}ms`);
    console.log(`  p95:  ${percentiles[95]}ms ${p95Pass ? "✅" : "❌"} (threshold < ${config.thresholdP95Ms}ms)`);
    console.log(`  p99:  ${percentiles[99]}ms ${p99Pass ? "✅" : "❌"} (threshold < ${config.thresholdP99Ms}ms)`);
    // Machine-readable baseline line — easy to grep in CI logs and to diff
    // across runs without parsing the full report.
    console.log(
      `BASELINE p50=${percentiles[50]}ms p95=${percentiles[95]}ms p99=${percentiles[99]}ms throughput=${Math.round(throughput)}rps`
    );
    if (config.ci && (!p95Pass || !p99Pass)) {
      console.error(
        `\n❌ CI gate failed: p95=${percentiles[95]}ms (limit ${config.thresholdP95Ms}ms), p99=${percentiles[99]}ms (limit ${config.thresholdP99Ms}ms)`
      );
      process.exitCode = 1;
      return;
    }
    console.log("\n✅ In-memory benchmark completed!");
  } finally {
    // Cleanup
    rmSync(tempDir, { recursive: true, force: true });
  }
}
// Daemon mode benchmark (stub for future implementation)
async function runDaemonBenchmark(config: BenchmarkConfig) {
  console.log("\n⚠️  Daemon mode benchmark is not implemented yet.");
  console.log("This will test the full hot path via unix socket in a future version.");
  console.log("\nFalling back to in-memory mode...");
  await runInMemoryBenchmark(config);
}
// Parse command line arguments
function parseArgs(): BenchmarkConfig {
  const args = process.argv.slice(2);
  const config = { ...DEFAULT_CONFIG };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--iterations" && i + 1 < args.length) {
      config.iterations = parseInt(args[++i], 10);
    } else if (arg === "--warmup" && i + 1 < args.length) {
      config.warmupIterations = parseInt(args[++i], 10);
    } else if (arg === "--mode" && i + 1 < args.length) {
      const mode = args[++i];
      if (mode === "in-memory" || mode === "daemon") {
        config.mode = mode;
      } else {
        throw new Error(`Invalid mode: ${mode}. Use "in-memory" or "daemon".`);
      }
    } else if (arg === "--query-type" && i + 1 < args.length) {
      const queryType = args[++i];
      if (["file", "command", "symbol", "mixed"].includes(queryType)) {
        config.queryType = queryType as any;
      } else {
        throw new Error(`Invalid query type: ${queryType}. Use "file", "command", "symbol", or "mixed".`);
      }
    } else if (arg === "--socket" && i + 1 < args.length) {
      config.socketPath = args[++i];
    } else if (arg === "--ci") {
      // CI mode: smaller load + non-zero exit on threshold miss. Iterations
      // and warmup are clamped to CI defaults unless the caller explicitly
      // overrode them earlier on the command line.
      config.ci = true;
      if (config.iterations === DEFAULT_CONFIG.iterations) config.iterations = CI_ITERATIONS;
      if (config.warmupIterations === DEFAULT_CONFIG.warmupIterations) config.warmupIterations = CI_WARMUP;
    } else if (arg === "--threshold-p95" && i + 1 < args.length) {
      config.thresholdP95Ms = parseFloat(args[++i]);
    } else if (arg === "--threshold-p99" && i + 1 < args.length) {
      config.thresholdP99Ms = parseFloat(args[++i]);
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}. Use --help for usage.`);
    }
  }
  return config;
}
function printHelp() {
  console.log(`
CodeMemory PreToolUse Lookup Benchmark
Usage: node benchmark/lookup-latency.ts [options]
Options:
  --iterations <number>   Number of benchmark iterations (default: 10000, CI: 1000)
  --warmup <number>       Number of warmup iterations (default: 1000, CI: 200)
  --mode <mode>           Benchmark mode: "in-memory" or "daemon" (default: in-memory)
  --query-type <type>     Query type: "file", "command", "symbol", or "mixed" (default: mixed)
  --socket <path>         Path to daemon unix socket (for daemon mode)
  --ci                    CI regression-gate mode: smaller load, exit 1 on threshold miss
  --threshold-p95 <ms>    p95 latency limit, ms (default: 200)
  --threshold-p99 <ms>    p99 latency limit, ms (default: 500)
  --help, -h              Show this help message
Examples:
  node benchmark/lookup-latency.ts --iterations 5000 --query-type file
  node benchmark/lookup-latency.ts --ci
  node benchmark/lookup-latency.ts --ci --threshold-p95 150
`);
}
// Main
async function main() {
  console.log("# CodeMemory PreToolUse Lookup Latency Benchmark");
  try {
    const config = parseArgs();
    if (config.mode === "in-memory") {
      await runInMemoryBenchmark(config);
    } else {
      await runDaemonBenchmark(config);
    }
  } catch (error) {
    console.error("\n❌ Benchmark failed:", error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
main().catch(console.error);

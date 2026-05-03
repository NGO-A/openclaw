import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RouterDecision } from "./router.js";

export type RouterTraceRecord = {
  ts: string;
  requestId?: string;
  sessionId?: string;
  sessionKey?: string;
  selectedModel?: string;
  selectedProvider?: string;
  routeClass: RouterDecision["routeClass"];
  candidates: RouterDecision["candidates"];
  reasons: string[];
  promptStored: false;
  latencyMs?: number;
  tokenEstimate?: number;
};

export function defaultTracePath(): string {
  return path.join(
    process.env.OPENCLAW_STATE_DIR || path.join(os.homedir(), ".openclaw"),
    "smart-model-router-trace.jsonl",
  );
}

export function appendTraceRecord(
  record: RouterTraceRecord,
  opts?: { tracePath?: string; maxEntries?: number },
) {
  const tracePath = opts?.tracePath ?? defaultTracePath();
  fs.mkdirSync(path.dirname(tracePath), { recursive: true });
  fs.appendFileSync(tracePath, `${JSON.stringify(record)}\n`, "utf8");
  trimTraceFile(tracePath, opts?.maxEntries ?? 200);
}

export function readRecentTraceRecords(opts?: {
  tracePath?: string;
  limit?: number;
}): RouterTraceRecord[] {
  const tracePath = opts?.tracePath ?? defaultTracePath();
  if (!fs.existsSync(tracePath)) {
    return [];
  }
  const limit = opts?.limit ?? 20;
  return fs
    .readFileSync(tracePath, "utf8")
    .split("\n")
    .filter(Boolean)
    .slice(-limit)
    .map((line) => JSON.parse(line) as RouterTraceRecord);
}

function trimTraceFile(tracePath: string, maxEntries: number) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0 || !fs.existsSync(tracePath)) {
    return;
  }
  const lines = fs.readFileSync(tracePath, "utf8").split("\n").filter(Boolean);
  if (lines.length <= maxEntries) {
    return;
  }
  fs.writeFileSync(tracePath, `${lines.slice(-maxEntries).join("\n")}\n`, "utf8");
}

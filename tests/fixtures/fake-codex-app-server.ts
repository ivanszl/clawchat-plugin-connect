#!/usr/bin/env bun
import { appendFileSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  process.stdout.write("codex-cli 0.145.0\n");
  process.exit(0);
}
if (process.argv[2] !== "app-server" || process.argv[3] !== "--stdio") process.exit(64);

const statePath = requiredEnvironment("CODEX_FAKE_STATE_FILE");
const lifecyclePath = requiredEnvironment("CODEX_FAKE_LIFECYCLE_FILE");
const closePath = requiredEnvironment("CODEX_FAKE_CLOSE_FILE");
const hangPath = requiredEnvironment("CODEX_FAKE_HANG_FILE");
const failArchivePath = requiredEnvironment("CODEX_FAKE_FAIL_ARCHIVE_FILE");
const thread = {
  id: "thread-1",
  preview: "Conformance",
  name: "Conformance",
  createdAt: 1,
  updatedAt: 1,
  recencyAt: 1,
  cwd: "/tmp",
  source: "cli",
  gitInfo: null,
  turns: [
    {
      id: "turn-1",
      status: "completed",
      items: Array.from({ length: 201 }, (_, index) => ({
        type: "agentMessage",
        id: `activity-${index}`,
        text: "same output",
      })),
    },
  ],
};

const lines = createInterface({ input: process.stdin, crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  const request = JSON.parse(line) as { id?: number | string; method: string; params?: Record<string, unknown> };
  if (request.id === undefined) return;
  if (request.method === "model/list" && existsSync(hangPath)) return;
  try {
    const result = responseFor(request.method, request.params ?? {});
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  } catch (error) {
    process.stdout.write(
      `${JSON.stringify({ id: request.id, error: { code: -32_000, message: error instanceof Error ? error.message : String(error) } })}\n`,
    );
  }
});
lines.on("close", close);

process.on("SIGTERM", close);
process.on("SIGINT", close);

function responseFor(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "initialize":
      return { userAgent: "codex-cli 0.145.0" };
    case "model/list":
      return {
        data: [
          {
            id: "gpt-5-codex",
            model: "gpt-5-codex",
            displayName: "GPT-5 Codex",
            description: "Fixture",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Medium" }],
            inputModalities: ["text", "image"],
          },
        ],
        nextCursor: null,
      };
    case "skills/list":
      return { data: [] };
    case "thread/list": {
      const state = readState();
      const wantsArchived = params.archived === true;
      const visible = wantsArchived ? state === "archived" : state === "active";
      return { data: visible ? [thread] : [], nextCursor: null };
    }
    case "thread/read":
      return { thread };
    case "thread/archive":
      if (existsSync(failArchivePath)) {
        rmSync(failArchivePath);
        throw new Error("native mutation is busy");
      }
      if (readState() === "active") appendFileSync(lifecyclePath, "archive\n");
      writeFileSync(statePath, "archived");
      return {};
    case "thread/unarchive":
      if (readState() === "archived") appendFileSync(lifecyclePath, "restore\n");
      writeFileSync(statePath, "active");
      return { thread };
    case "thread/delete":
      if (readState() !== "deleted") appendFileSync(lifecyclePath, "delete\n");
      writeFileSync(statePath, "deleted");
      return {};
    default:
      throw new Error(`unsupported fixture request: ${method}`);
  }
}

function readState(): string {
  return existsSync(statePath) ? readFileSync(statePath, "utf8").trim() : "deleted";
}

function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

let closeRecorded = false;

function close(): never {
  if (!closeRecorded) {
    closeRecorded = true;
    appendFileSync(closePath, "close\n");
  }
  process.exit(0);
}

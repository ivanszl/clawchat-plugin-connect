// A stand-in for the `dsh` executable that speaks the DSH Bridge protocol (major 2) on the inherited pipes:
// frames go to Connect on fd 3 and requests arrive on fd 4. Every prompt is answered with a one-message Turn.
import { createReadStream, writeSync } from "node:fs";
import { createInterface } from "node:readline";

const profileIndex = process.argv.indexOf("--profile");
const profile = profileIndex >= 0 ? process.argv[profileIndex + 1] : null;
const send = (frame) => writeSync(3, `${JSON.stringify(frame)}\n`);
const capabilities = Object.fromEntries(
  [
    "promptQueue",
    "promptSteer",
    "cancel",
    "durableReceipt",
    "history",
    "approvals",
    "questions",
    "models",
    "presets",
    "permissionPresets",
    "skills",
    "commands",
    "imageInput",
    "localProducedFilePresentation",
    "portableArtifactOutput",
    "archive",
    "restore",
    "delete",
    "crossProcessSessionOwnership",
  ].map((name) => [name, ["promptQueue", "promptSteer", "cancel", "durableReceipt", "history", "approvals", "models"].includes(name)]),
);
send({
  type: "hello",
  protocol: { name: "clawchat-connect-dsh-bridge", major: 2, build: "fake" },
  home: process.env.DSH_HOME,
  profile,
  capabilities,
});

let sequence = 0;
const cwds = new Map();
const emit = (sessionId, type, data) =>
  send({ type: "event", sessionId, event: { seq: ++sequence, time: sequence, type, data } });

const lines = createInterface({ input: createReadStream(null, { fd: 4 }), crlfDelay: Number.POSITIVE_INFINITY });
lines.on("line", (line) => {
  const { id, method, params = {} } = JSON.parse(line);
  const reply = (result) => send({ type: "response", id, ok: true, result });
  const sessionId = params.sessionId ?? "missing";
  if (method === "create" && params.cwd) cwds.set(sessionId, params.cwd);
  const cwd = cwds.get(sessionId) ?? process.cwd();
  if (method === "create" || method === "resume") return reply({ sessionId, header: { id: sessionId, createdAt: 1, cwd } });
  if (method === "history") {
    return reply({ header: { id: sessionId, createdAt: 1, cwd }, events: [], complete: true, nextBeforeSeq: null });
  }
  if (method === "models") return reply([]);
  if (method === "prompt") {
    reply({ inputId: params.inputId, messageId: params.inputId });
    setTimeout(() => {
      emit(sessionId, "turn/start", { turn: 1 });
      emit(sessionId, "assistant/message", {
        turn: 1,
        step: 0,
        message: { content: [{ type: "text", text: "scripted reply" }] },
      });
      emit(sessionId, "turn/end", { turn: 1, reason: { kind: "completed" } });
    }, 20);
    return;
  }
  if (method === "shutdown") {
    reply({});
    setTimeout(() => process.exit(0), 10);
    return;
  }
  send({ type: "response", id, ok: false, error: { code: "unsupported", message: `fake dsh: ${method}` } });
});
lines.on("close", () => process.exit(0));

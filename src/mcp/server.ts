import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type * as z from "zod";
import { loadConfig, getAgent } from "../config.js";
import { createStateStore, type ConnectStateStore } from "../state.js";
import { createFileBackedMemoryPort, createStandaloneMentionMessagePort } from "../tools/ports.js";
import { CLAWCHAT_TOOL_DEFINITIONS, type ClawChatToolContext, type MentionMessagePort, type MemoryPort } from "../tools/registry.js";

export interface StartMcpStdioServerOptions { agentId?: string; configPath?: string; stateStore?: ConnectStateStore; mentionMessage?: MentionMessagePort; memory?: MemoryPort; chatId?: string | null; version?: string; }

export async function startMcpStdioServer(options: StartMcpStdioServerOptions = {}): Promise<void> {
  const config = await loadConfig(options.configPath);
  const agentId = options.agentId ?? process.env.CLAWCHAT_CONNECT_AGENT_ID ?? config.defaultAgent;
  if (!agentId) throw new Error("agent is required for clawchat-connect mcp-server; pass --agent or set defaultAgent");
  getAgent(config, agentId);
  const stateStore = options.stateStore ?? createStateStore({ dbPath: config.stateDbPath });
  const context: ClawChatToolContext = { agentId, config, stateStore, chatId: options.chatId ?? process.env.CLAWCHAT_CONNECT_CHAT_ID ?? null, mentionMessage: options.mentionMessage ?? createStandaloneMentionMessagePort({ config, stateStore, agentId }), memory: options.memory ?? createFileBackedMemoryPort(config) };
  const server = new McpServer({ name: "clawchat-connect", version: options.version ?? "0.1.0" });
  for (const tool of CLAWCHAT_TOOL_DEFINITIONS) {
    const inputSchema = (tool.inputSchema as { shape: z.ZodRawShape }).shape;
    server.registerTool(tool.name, { description: tool.description, inputSchema }, async (input) => {
      const result = await tool.execute(input, context);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    });
  }
  await server.connect(new StdioServerTransport());
}

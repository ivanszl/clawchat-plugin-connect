import type { ConnectRuntimeAdapter } from "../runtime/acp-adapter.js";
import { CLAWCHAT_TOOL_DEFINITIONS, type ClawChatToolContext, type ClawChatToolDefinition } from "./registry.js";

export interface DynamicToolRuntimeSession { registerTools?: (tools: ClawChatToolDefinition[], context: ClawChatToolContext) => Promise<boolean> | boolean; }
export interface ToolBridgeResult { registered: boolean; reason?: string; }

export async function registerClawChatToolsBestEffort(session: DynamicToolRuntimeSession, context: ClawChatToolContext): Promise<ToolBridgeResult> {
  if (typeof session.registerTools !== "function") return { registered: false, reason: "runtime session does not support dynamic tool registration; use the stdio MCP server" };
  const ok = await session.registerTools(CLAWCHAT_TOOL_DEFINITIONS, context);
  return ok ? { registered: true } : { registered: false, reason: "runtime declined dynamic tool registration; use the stdio MCP server" };
}

export function assertAcpBridgeBoundary(_adapter: ConnectRuntimeAdapter): void {
  // This intentionally has no ACP SDK imports. ACP-specific mapping stays in
  // src/runtime/acp-adapter.ts; this module owns only registry-level shapes.
}

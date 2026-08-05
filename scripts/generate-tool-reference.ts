import { CONNECT_TOOL_CATALOG, toolJsonSchema } from "../src/agent/tool-catalog";

const lines = [
  "# ClawChat tool reference",
  "",
  "This file is generated from `src/agent/tool-catalog.ts`. Do not edit it directly.",
  "",
];
for (const tool of CONNECT_TOOL_CATALOG) {
  lines.push(`## \`${tool.name}\``, "", tool.description, "", "Input:", "", "```json");
  lines.push(JSON.stringify(toolJsonSchema(tool), null, 2), "```", "");
}
await Bun.write(new URL("../skills/clawchat-core/references/tools.md", import.meta.url), `${lines.join("\n")}\n`);

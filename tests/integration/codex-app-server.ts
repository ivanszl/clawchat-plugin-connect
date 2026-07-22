import { createCodexAppServerClient, SUPPORTED_CODEX_VERSION } from "../../src/runtime/codex-app-server";

const executable = process.env.CODEX_INTEGRATION_PATH?.trim();
const client = await createCodexAppServerClient({
  kind: "codex",
  ...(executable ? { codexPathOverride: executable } : {}),
});
try {
  process.stdout.write(`Verified ${SUPPORTED_CODEX_VERSION} app-server initialize handshake.\n`);
} finally {
  await client.close();
}

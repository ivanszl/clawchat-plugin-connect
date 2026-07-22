import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

const port = 49_000 + Math.floor(Math.random() * 10_000);
const origin = `http://127.0.0.1:${port}`;
const server = Bun.spawn({
  cmd: [process.execPath, "tests/fixtures/client-preview-server.ts"],
  cwd: process.cwd(),
  env: { ...process.env, CONNECT_CLIENT_PREVIEW_PORT: String(port) },
  stdout: "pipe",
  stderr: "inherit",
});

try {
  await waitForServer(`${origin}/client/v1/bootstrap`);
  const executablePath = await localChromiumPath();
  const browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
  try {
    const page = await browser.newPage();
    const createRequests: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/client/v1/sessions") return;
      createRequests.push(request.postDataJSON());
    });
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "选择一个 Session" })).toBeVisible();

    await page.getByRole("button", { name: "新建 Session" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: /^名称/u }).fill("Browser-created Session");
    await dialog.getByRole("textbox", { name: "首个任务" }).fill("Browser first task");
    await choose(page, dialog.getByRole("combobox", { name: "Project" }), "clawchat-plugin-connect");
    await choose(page, dialog.getByRole("combobox", { name: "模式" }), "read-only");
    await choose(page, dialog.getByRole("combobox", { name: "模型" }), "Deep model (gpt-deep)");

    const effort = dialog.getByRole("combobox", { name: "推理强度" });
    await expect(effort).toContainText("high");
    await effort.click();
    await expect(page.getByRole("option", { name: "xhigh", exact: true })).toBeVisible();
    await page.getByRole("option", { name: "xhigh", exact: true }).click();
    await dialog.getByRole("button", { name: "创建 Session" }).click();

    await expect(page.getByRole("heading", { name: "Browser-created Session" })).toBeVisible();
    await expect(page.getByText("Browser first task", { exact: true }).last()).toBeVisible();
    await expect(page.getByText(/生效：gpt-deep · xhigh（Session）/u)).toBeVisible();
    assert.equal(createRequests.length, 1, "new Session UI must submit one semantic request");
    assert.deepEqual(withoutRequestId(createRequests[0]), {
      prompt: "Browser first task",
      bindingId: "codex",
      projectId: "connect",
      name: "Browser-created Session",
      mode: "read-only",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
    });

    await page.getByText("Non-Project scratch", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Non-Project scratch" })).toBeVisible();
    await expect(page.getByText("模型不可用", { exact: true })).toBeVisible();
    await expect(page.getByText(/生效：gpt-removed · high（Session）/u)).toBeVisible();
    await expect(page.getByRole("combobox", { name: "Session 模型" })).toContainText("gpt-removed（不可用）");

    await page.getByRole("button", { name: "设置" }).click();
    await expect(page.getByRole("heading", { name: "安全偏好设置" })).toBeVisible();
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await expect(page.getByRole("alert").filter({ hasText: "移除失败" })).toContainText("still reference this Project");

    process.stdout.write(
      "Verified accessible Connect Client Session creation, model choices, unavailable state, and Project conflicts.\n",
    );
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  await server.exited;
}

async function choose(page: Page, combobox: Locator, optionName: string): Promise<void> {
  await combobox.click();
  await page.getByRole("option", { name: optionName, exact: true }).click();
}

function withoutRequestId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { requestId: _requestId, ...body } = value as Record<string, unknown>;
  return body;
}

async function waitForServer(url: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview process is still starting.
    }
    await Bun.sleep(50);
  }
  throw new Error(`Connect Client preview did not start at ${url}`);
}

async function localChromiumPath(): Promise<string | null> {
  const candidates = [
    process.env.CHROMIUM_PATH,
    process.env.BRAVE_PATH,
    process.platform === "darwin" ? "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" : undefined,
    process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : undefined,
    process.platform === "linux" ? "/usr/bin/brave-browser" : undefined,
    process.platform === "linux" ? "/usr/bin/brave" : undefined,
    process.platform === "linux" ? "/usr/bin/chromium" : undefined,
    process.platform === "linux" ? "/usr/bin/google-chrome" : undefined,
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local Chromium-compatible browser.
    }
  }
  return null;
}

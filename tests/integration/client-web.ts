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
    await verifySmallWindowNavigation(browser, origin);
    const page = await browser.newPage();
    const createRequests: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/client/v1/sessions") return;
      createRequests.push(request.postDataJSON());
    });
    await page.goto(origin);
    await expect(page.getByRole("heading", { name: "选择一个 Session" })).toBeVisible();
    const navigation = page.locator(".session-nav");
    await navigation.getByText("clawchat-plugin-connect", { exact: true }).click();
    await expect(navigation.getByText("ABCDEFGH", { exact: false })).toHaveCount(0);
    await expect(navigation.getByText("JKLMNPQR", { exact: false })).toHaveCount(0);
    await expect(navigation.getByRole("img", { name: "空闲" })).toHaveCount(3);

    await page.getByRole("button", { name: "新建 Session" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: /^名称/u }).fill("Browser-created Session");
    await expect(dialog.getByRole("textbox", { name: "首个任务" })).toHaveCount(0);
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
    await expect(page.locator(".session-header").getByRole("combobox", { name: "Session 模型" })).toHaveCount(0);
    const modelTrigger = page.getByRole("button", { name: /模型设置：Deep model · xhigh/u });
    await expect(modelTrigger).toBeVisible();
    await modelTrigger.click();
    const modelPopover = page.getByRole("dialog", { name: "Session 模型设置" });
    await expect(modelPopover.getByRole("combobox", { name: "Session 模型" })).toContainText("Deep model");
    await expect(modelPopover.getByRole("combobox", { name: "推理强度" })).toContainText("xhigh");
    await page.keyboard.press("Escape");
    assert.equal(createRequests.length, 1, "new Session UI must submit one semantic request");
    assert.deepEqual(withoutRequestId(createRequests[0]), {
      bindingId: "codex",
      projectId: "connect",
      name: "Browser-created Session",
      mode: "read-only",
      model: "gpt-deep",
      reasoningEffort: "xhigh",
    });

    await page.getByText("Non-Project scratch", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "Non-Project scratch" })).toBeVisible();
    await page.getByRole("button", { name: /模型设置：gpt-removed · high/u }).click();
    const unavailablePopover = page.getByRole("dialog", { name: "Session 模型设置" });
    await expect(unavailablePopover.getByText("模型不可用", { exact: true })).toBeVisible();
    await expect(unavailablePopover.getByRole("combobox", { name: "Session 模型" })).toContainText(
      "gpt-removed（不可用）",
    );
    await page.keyboard.press("Escape");

    await verifyLongSessionNameDoesNotOverflow(page);
    await page.getByRole("button", { name: "设置", exact: true }).click();
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

async function verifySmallWindowNavigation(browser: Awaited<ReturnType<typeof chromium.launch>>, origin: string) {
  const viewport = { width: 442, height: 704 };
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(origin);
    await expect(page).toHaveTitle("ClawChat Connect");
    const refresh = page.getByRole("button", { name: "刷新全部 Session" });
    const settings = page.getByRole("button", { name: "设置" });
    const [refreshBox, settingsBox] = await Promise.all([refresh.boundingBox(), settings.boundingBox()]);
    assert(refreshBox && settingsBox, "refresh and settings actions must be visible in the top navigation");
    assert(refreshBox.width <= 44, "refresh must be an icon-only top navigation action");
    assert(settingsBox.width <= 44, "settings must be an icon-only top navigation action");
    const settingsGeometry = await settings.locator("svg path").evaluate((path) => {
      const box = (path as SVGGraphicsElement).getBBox();
      return { centerX: box.x + box.width / 2, centerY: box.y + box.height / 2 };
    });
    assert(
      Math.abs(settingsGeometry.centerX - 12) <= 0.1 && Math.abs(settingsGeometry.centerY - 12) <= 0.1,
      `settings gear must be centered in its 24px viewBox: ${JSON.stringify(settingsGeometry)}`,
    );
    assert(
      Math.abs(refreshBox.y - settingsBox.y) <= 1 && refreshBox.x < settingsBox.x,
      `refresh must sit before settings in the top navigation: ${JSON.stringify({ refreshBox, settingsBox })}`,
    );

    await page.getByTestId("mobile-nav-toggle").click();
    const dialog = page.locator("dialog[open]");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("link", { name: "ClawChat Connect" })).toBeVisible();
    await expect(dialog.getByText("Local agent relay", { exact: true })).toHaveCount(0);
    const drawer = dialog.locator(":scope > div");
    const drawerBox = await drawer.boundingBox();
    assert(drawerBox, "small-window navigation drawer must have a bounding box");
    assert.equal(Math.round(drawerBox.x), 0, "small-window navigation drawer must start at the viewport edge");
    assert.equal(
      Math.round(drawerBox.width),
      viewport.width,
      "small-window navigation drawer must fill the viewport width",
    );

    const createButton = page.getByRole("button", { name: "新建 Session" });
    const search = page.getByRole("textbox", { name: "搜索 Session" });
    const [createBox, searchBox] = await Promise.all([createButton.boundingBox(), search.boundingBox()]);
    assert(createBox && searchBox, "small-window navigation tools must be visible");
    assert(createBox.width <= 44, "new Session must be an icon-only action");
    assert(
      Math.abs(createBox.y - searchBox.y) <= 1 && searchBox.x < createBox.x,
      `Session search must precede new Session on the same row: ${JSON.stringify({ createBox, searchBox })}`,
    );
    assert(
      searchBox.width >= drawerBox.width * 0.75,
      `Session search must use the drawer width: ${JSON.stringify({ drawerBox, searchBox })}`,
    );

    await createButton.click();
    const createDialog = page.locator("dialog.new-session-dialog");
    await expect(createDialog).toBeVisible();
    await expect(createDialog.getByRole("textbox", { name: "首个任务" })).toHaveCount(0);
    const submit = createDialog.getByRole("button", { name: "创建 Session" });
    const submitBox = await submit.boundingBox();
    assert(submitBox, "new Session confirmation must be visible");
    assert(
      submitBox.y + submitBox.height <= viewport.height,
      `new Session confirmation must remain inside the viewport: ${JSON.stringify({ submitBox, viewport })}`,
    );
    const scrollRegion = createDialog.locator(".new-session-dialog-content");
    await expect(scrollRegion).toHaveCSS("overflow-y", "auto");
  } finally {
    await page.close();
  }
}

async function verifyLongSessionNameDoesNotOverflow(page: Page) {
  const longName = "$grill-with-docs 根据https://github.com/clawling/clawnest-liveware，connect web可以使用liveware "
    .repeat(2)
    .trim();
  const response = await page.evaluate(async (name) => {
    const request = await fetch("/client/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindingId: "codex",
        projectId: "connect",
        name,
        mode: null,
        model: null,
        reasoningEffort: null,
        requestId: crypto.randomUUID(),
      }),
    });
    return { ok: request.ok, status: request.status, body: await request.json() };
  }, longName);
  assert(response.ok, `long-name Session creation failed: ${response.status}`);
  const created = response.body as { sessionRef: string };
  await page.goto(`${origin}/sessions/${created.sessionRef}`);

  const heading = page.getByRole("heading", { name: longName });
  await expect(heading).toBeVisible();
  await expect(heading).toHaveAttribute("title", longName);
  const layout = await page.evaluate(() => {
    const sessionPage = document.querySelector<HTMLElement>(".session-page");
    const sessionHeader = document.querySelector<HTMLElement>(".session-header");
    const title = document.querySelector<HTMLElement>(".session-heading h1");
    if (!sessionPage || !sessionHeader || !title) throw new Error("Missing Session title layout");
    return {
      viewportWidth: document.documentElement.clientWidth,
      documentWidth: document.documentElement.scrollWidth,
      pageClientWidth: sessionPage.clientWidth,
      pageScrollWidth: sessionPage.scrollWidth,
      headerClientWidth: sessionHeader.clientWidth,
      headerScrollWidth: sessionHeader.scrollWidth,
      titleClientWidth: title.clientWidth,
      titleScrollWidth: title.scrollWidth,
      titleOverflow: getComputedStyle(title).overflow,
      titleTextOverflow: getComputedStyle(title).textOverflow,
      titleWhiteSpace: getComputedStyle(title).whiteSpace,
    };
  });
  assert.equal(
    layout.documentWidth,
    layout.viewportWidth,
    `long Session name must not widen the document: ${JSON.stringify(layout)}`,
  );
  assert.equal(
    layout.pageScrollWidth,
    layout.pageClientWidth,
    `long Session name must not widen the Session page: ${JSON.stringify(layout)}`,
  );
  assert.equal(
    layout.headerScrollWidth,
    layout.headerClientWidth,
    `long Session name must not widen the Session header: ${JSON.stringify(layout)}`,
  );
  assert(
    layout.titleScrollWidth > layout.titleClientWidth,
    `long Session title must be visually truncated: ${JSON.stringify(layout)}`,
  );
  assert.equal(layout.titleOverflow, "hidden");
  assert.equal(layout.titleTextOverflow, "ellipsis");
  assert.equal(layout.titleWhiteSpace, "nowrap");
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

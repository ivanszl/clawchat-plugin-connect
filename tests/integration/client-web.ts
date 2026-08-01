import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, expect, type Locator, type Page } from "@playwright/test";

const port = await availablePort();
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
    await verifyRuntimeApproval(browser, origin);
    await verifyTranscriptCompletenessIsSilent(browser, origin);
    await verifySessionNavigationStaysInSpa(browser, origin);
    await verifyExternalTuiRefresh(browser, origin);
    await verifyComposerWorkingState(browser, origin);
    await verifyEmbeddedMobileNavigationDoesNotOverflow(browser, origin);
    await verifySmallWindowNavigation(browser, origin);
    await verifyResponsiveArtifactWorkspace(browser, origin);
    await verifyTranscriptAlwaysFollowsLatest(browser, origin);
    await verifyTranscriptPresentation(browser, origin);
    await verifyContinueInClawChat(browser, origin);
    await verifyImeConfirmationDoesNotSubmit(browser, origin);
    await verifyComposerReturnsIdleAfterTurn(browser, origin);
    await verifyComposerDoesNotStickAfterUnobservedFastTurn(browser, origin);
    await verifySkillPicker(browser, origin);
    const page = await browser.newPage();
    const createRequests: unknown[] = [];
    page.on("request", (request) => {
      if (request.method() !== "POST" || new URL(request.url()).pathname !== "/client/v1/sessions") return;
      createRequests.push(request.postDataJSON());
    });
    await page.goto(origin);
    const projectViews = await page.evaluate(async () => await (await fetch("/client/v1/projects")).json());
    const connectWorkspaceId = (projectViews as Array<{ workspaceId: string; name: string }>).find(
      (project) => project.name === "clawchat-plugin-connect",
    )?.workspaceId;
    assert(connectWorkspaceId, "preview Project must expose its Workspace ID");
    await expect(page.getByRole("heading", { name: "选择一个 Session" })).toBeVisible();
    const navigation = page.locator(".session-nav");
    await navigation.getByText("clawchat-plugin-connect", { exact: true }).click();
    await expect(navigation.getByText("ABCDEFGH", { exact: false })).toHaveCount(0);
    await expect(navigation.getByText("JKLMNPQR", { exact: false })).toHaveCount(0);
    await expect(navigation.getByRole("img", { name: "空闲" })).toHaveCount(0);
    await expect(navigation.getByRole("img", { name: "已连接" })).toHaveCount(1);

    await page.getByRole("button", { name: "新建 Session" }).click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("textbox", { name: /^名称/u }).fill("Browser-created Session");
    await expect(dialog.getByRole("textbox", { name: "首个任务" })).toHaveCount(0);
    await dialog.getByRole("combobox", { name: "Project" }).click();
    await expect(page.getByRole("option", { name: "discovered-workspace", exact: true })).toHaveCount(1);
    await expect(page.getByText("已发现工作区", { exact: false })).toHaveCount(0);
    await expect(page.getByRole("option", { name: "clawchat-plugin-connect", exact: true })).toBeVisible();
    await expect(page.getByRole("option", { name: "connect-qa", exact: true })).toHaveCount(0);
    await page.keyboard.press("Escape");
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
    const createdSessionRef = new URL(page.url()).pathname.split("/").at(-1);
    assert(createdSessionRef, "created Session URL must include its Session Ref");
    await expect(page.locator(".session-header").getByText(/clawchat-plugin-connect/iu)).toHaveCount(0);
    await expect(page.locator(".composer-note")).toHaveText(`clawchat-plugin-connect / ${createdSessionRef}`);
    await expect(page.getByRole("link", { name: "继续在 ClawChat 聊天" })).toHaveCount(0);
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
      workspaceId: connectWorkspaceId,
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
    await page
      .locator(".project-settings-row")
      .filter({ hasText: "clawchat-plugin-connect" })
      .getByRole("button", { name: "移除", exact: true })
      .click();
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

async function verifyTranscriptCompletenessIsSilent(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage();
  let completeness: "partial" | "live-only" = "partial";
  try {
    await page.route(/\/client\/v1\/sessions\/ABCDEFGH(?:\?refresh=1)?$/u, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, transcriptCompleteness: completeness } });
    });
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    await expect(page.getByText("部分工具执行细节可能缺失。", { exact: true })).toHaveCount(0);

    completeness = "live-only";
    await page.reload();
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    await expect(
      page.getByText("仅显示 Connect 已同步的消息；此 Session 的早期 Runtime 历史不可用。", { exact: true }),
    ).toHaveCount(0);
  } finally {
    await page.close();
  }
}

async function verifySessionNavigationStaysInSpa(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage();
  try {
    await page.addInitScript(() => {
      const key = "connect-document-load-count";
      const count = Number(sessionStorage.getItem(key) ?? "0");
      sessionStorage.setItem(key, String(count + 1));
    });
    await page.goto(previewOrigin);
    const navigation = page.locator(".session-nav");
    await navigation.getByText("clawchat-plugin-connect", { exact: true }).click();
    await navigation.getByText("App Server 与 Web Client", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    assert.equal(
      await page.evaluate(() => Number(sessionStorage.getItem("connect-document-load-count"))),
      1,
      "opening a Session from navigation must not reload the document",
    );
  } finally {
    await page.close();
  }
}

async function verifyRuntimeApproval(browser: Awaited<ReturnType<typeof chromium.launch>>, previewOrigin: string) {
  const page = await browser.newPage();
  try {
    const responses: unknown[] = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/client\/v1\/runtime-interactions\/[^/]+\/respond$/u.test(new URL(request.url()).pathname)
      ) {
        responses.push(request.postDataJSON());
      }
    });
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    const approval = page.locator(".runtime-interaction-card").filter({ hasText: "允许 Codex 更新本地 Connect？" });
    await expect(approval).toBeVisible();
    await expect(approval).toContainText("install dist/clawchat-connect ~/.local/bin/clawchat-connect");
    await approval.getByRole("button", { name: "仅此次允许", exact: true }).click();
    await expect(approval.getByText("已处理 · Web", { exact: true })).toBeVisible();
    await expect(approval.getByRole("button", { name: "仅此次允许", exact: true })).toHaveCount(0);
    assert.equal(responses.length, 1, "approval UI must submit one response");
    assert.deepEqual(withoutRequestId(responses[0]), { optionId: "approve-once" });
  } finally {
    await page.close();
  }
}

async function verifyImeConfirmationDoesNotSubmit(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage();
  try {
    let submittedTurns = 0;
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        new URL(request.url()).pathname.startsWith("/client/v1/sessions/ABCDEFGH/turn-submissions/")
      ) {
        submittedTurns += 1;
      }
    });
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    const input = page.locator(".session-composer [contenteditable='true']");
    await input.fill("中文");
    await input.dispatchEvent("compositionstart");
    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      bubbles: true,
      cancelable: true,
      isComposing: true,
    });
    await input.dispatchEvent("compositionend");
    await page.waitForTimeout(50);

    assert.equal(submittedTurns, 0, "Enter used to confirm IME composition must not submit a turn");
    await expect(input).toHaveText("中文");

    await input.dispatchEvent("keydown", {
      key: "Enter",
      code: "Enter",
      keyCode: 229,
      bubbles: true,
      cancelable: true,
    });
    await page.waitForTimeout(50);
    assert.equal(submittedTurns, 0, "IME compatibility Enter keyCode must not submit a turn");
    await expect(input).toHaveText("中文");
  } finally {
    await page.close();
  }
}

async function verifySkillPicker(browser: Awaited<ReturnType<typeof chromium.launch>>, previewOrigin: string) {
  const page = await browser.newPage();
  try {
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    const input = page.locator(".session-composer [contenteditable='true']");
    await input.fill("/gr");
    const picker = page.getByRole("listbox", { name: "命令和 Skills" });
    await expect(picker).toBeVisible();
    await expect(picker.getByRole("option", { name: /grill-with-docs/u })).toContainText("结合官方文档追问并检验方案");
    await expect(picker).not.toContainText("/repo/");
    await input.fill("/com");
    await expect(picker.getByRole("option", { name: /compact/u })).toContainText("Compact the Session context");
    await picker.getByRole("option", { name: /compact/u }).click();
    await expect(input).toHaveText("/compact ");
    await input.fill("/gr");
    await picker.getByRole("option", { name: /grill-with-docs/u }).click();
    await expect(input).toHaveText("/grill-with-docs ");
    await input.fill("/res");
    await picker.getByRole("option", { name: /research/u }).click();
    await expect(input).toHaveText("/research ");
    await input.fill("/gr");
    await picker.getByRole("option", { name: /grill-with-docs/u }).click();
    await input.fill("/grill-with-docs 评审 Skill discovery 方案");
    await page.getByRole("button", { name: "Send" }).click();
    await expect(page.getByText("/grill-with-docs 评审 Skill discovery 方案", { exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
}

async function verifyComposerWorkingState(browser: Awaited<ReturnType<typeof chromium.launch>>, previewOrigin: string) {
  const page = await browser.newPage({ viewport: { width: 320, height: 704 } });
  try {
    await page.route(/\/client\/v1\/events/u, async (route) => await route.abort("blockedbyclient"));
    await page.route(/\/client\/v1\/sessions\/ABCDEFGH(?:\?refresh=1)?$/u, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, status: "running" } });
    });
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    const stop = page.getByRole("button", { name: "停止", exact: true });
    await expect(stop).toBeVisible();
    await expect(stop.getByTestId("agent-working-spinner")).toBeVisible();
    await expect(page.locator(".composer-working-indicator")).toHaveCount(0);
    const [stopBox, composerBox] = await Promise.all([
      stop.boundingBox(),
      page.locator(".session-composer").boundingBox(),
    ]);
    assert(
      stopBox && composerBox && stopBox.x + stopBox.width <= composerBox.x + composerBox.width,
      `working control must remain inside the small-window composer: ${JSON.stringify({ stopBox, composerBox })}`,
    );
    assert(stopBox.width > stopBox.height, "working state must show a visible Stop label, not an icon alone");

    const input = page.locator(".session-composer [contenteditable='true']");
    await input.fill("运行中加入队列");
    const send = page.getByRole("button", { name: "Send", exact: true });
    await expect(send).toBeVisible();
    await expect(stop).toHaveCount(0);
    await send.click();
    await expect(input).toHaveText("");
  } finally {
    await page.close();
  }
}

async function verifyComposerReturnsIdleAfterTurn(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage();
  try {
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    const input = page.locator(".session-composer [contenteditable='true']");
    await input.fill("状态收敛测试");
    await input.press("Enter");
    await expect(page.getByTestId("agent-working-spinner")).toBeVisible();
    await expect(page.getByText("这是 Preview Runtime 的本地回复；它不会发送到 ClawChat。").last()).toBeVisible();
    await expect(page.getByTestId("agent-working-spinner")).toHaveCount(0, { timeout: 5_000 });
  } finally {
    await page.close();
  }
}

async function verifyComposerDoesNotStickAfterUnobservedFastTurn(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage();
  try {
    await page.route(/\/client\/v1\/events/u, async (route) => await route.abort("blockedbyclient"));
    await page.route(/\/client\/v1\/sessions\/ABCDEFGH(?:\?refresh=1)?$/u, async (route) => {
      const response = await route.fetch();
      const body = (await response.json()) as Record<string, unknown>;
      await route.fulfill({ response, json: { ...body, status: "idle" } });
    });
    await page.route(/\/client\/v1\/sessions\/ABCDEFGH\/turn-submissions\//u, async (route) => {
      await route.fulfill({
        status: 202,
        contentType: "application/json",
        body: JSON.stringify({ accepted: true, turnId: "fast-turn", sessionRef: "ABCDEFGH" }),
      });
    });
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    const input = page.locator(".session-composer [contenteditable='true']");
    await input.fill("极快完成的任务");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await expect(input).toHaveText("");
    await expect(page.getByTestId("agent-working-spinner")).toHaveCount(0, { timeout: 1_000 });
    await expect(page.getByRole("button", { name: "Send", exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
}

async function verifyContinueInClawChat(browser: Awaited<ReturnType<typeof chromium.launch>>, previewOrigin: string) {
  const page = await browser.newPage({
    viewport: { width: 320, height: 704 },
    userAgent: "Mozilla/5.0 ConnectClientTest clawchat",
  });
  try {
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    const mobileStressLabel =
      "$grill-with-docs 根据https://github.com/clawling/clawnest-liveware，connect web可以使用liveware".repeat(3);
    await page.locator(".session-heading h1").evaluate((element, label) => {
      element.textContent = label;
      element.setAttribute("title", label);
    }, mobileStressLabel);
    await page.locator(".composer-note").evaluate((element, label) => {
      element.textContent = label;
      element.setAttribute("title", label);
    }, mobileStressLabel);

    const sessionRef = new URL(page.url()).pathname.split("/").at(-1);
    assert(sessionRef, "fixture Session URL must include its Session Ref");
    const action = page.getByRole("link", { name: "继续在 ClawChat 聊天" });
    await expect(action).toBeVisible();
    await expect(action).toHaveAttribute(
      "href",
      `clawchat://u/usr_connect_preview?chat=1&draft=${encodeURIComponent(`/switch ${sessionRef}`)}`,
    );

    const [contextBox, actionBox] = await Promise.all([
      page.locator(".composer-note").boundingBox(),
      action.boundingBox(),
    ]);
    assert(contextBox && actionBox, "ClawChat continuation action and Session context must be visible");
    assert(
      contextBox.x < actionBox.x && Math.abs(contextBox.y - actionBox.y) <= actionBox.height,
      `continuation action must follow Session context in the composer footer: ${JSON.stringify({
        contextBox,
        actionBox,
      })}`,
    );
    assert(actionBox.width <= 44, `mobile continuation action must collapse to an icon: ${JSON.stringify(actionBox)}`);
    const width = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
      layoutClient: document.querySelector<HTMLElement>(".astryx-layout-content")?.clientWidth,
      layoutScroll: document.querySelector<HTMLElement>(".astryx-layout-content")?.scrollWidth,
      composerClient: document.querySelector<HTMLElement>(".composer-region")?.clientWidth,
      composerScroll: document.querySelector<HTMLElement>(".composer-region")?.scrollWidth,
      layoutScrollLeft: (() => {
        const layout = document.querySelector<HTMLElement>(".astryx-layout-content");
        if (!layout) return null;
        layout.scrollLeft = 100;
        return layout.scrollLeft;
      })(),
    }));
    assert.equal(
      width.scroll,
      width.client,
      `continuation action must not widen a small window: ${JSON.stringify(width)}`,
    );
    assert.equal(
      width.layoutScroll,
      width.layoutClient,
      `Connect content must not become horizontally scrollable: ${JSON.stringify(width)}`,
    );
    assert.equal(
      width.composerScroll,
      width.composerClient,
      `Session composer must fit its mobile grid track: ${JSON.stringify(width)}`,
    );
    assert.equal(
      width.layoutScrollLeft,
      0,
      `Connect content must reject horizontal dragging: ${JSON.stringify(width)}`,
    );
  } finally {
    await page.close();
  }
}

async function verifyTranscriptAlwaysFollowsLatest(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage({ viewport: { width: 900, height: 420 } });
  try {
    await page.goto(previewOrigin);
    const navigation = page.locator(".session-nav");
    await navigation.getByText("clawchat-plugin-connect", { exact: true }).click();
    await navigation.getByText("App Server 与 Web Client", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    const sessionRef = new URL(page.url()).pathname.split("/").at(-1);
    assert(sessionRef, "fixture Session URL must include its Session Ref");
    const transcript = page.locator(".transcript-scroll");

    let blockCount = await transcriptBlockCount(page, sessionRef);
    for (let index = 0; index < 8; index += 1) {
      await postPreviewTurn(page, sessionRef, `滚动测试 ${index}`);
      blockCount += 2;
      await expect.poll(async () => await transcriptBlockCount(page, sessionRef)).toBe(blockCount);
    }

    await page.reload();
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    await expect
      .poll(async () => await bottomDistance(transcript), {
        message: "Session entry and refresh must anchor at the end",
      })
      .toBeLessThanOrEqual(2);
    await page.waitForTimeout(120);

    await transcript.evaluate((element) => {
      element.scrollTop = 0;
      element.dispatchEvent(new Event("scroll"));
    });
    await expect.poll(async () => await transcript.evaluate((element) => element.scrollTop)).toBe(0);
    const previousScrollHeight = await transcript.evaluate((element) => element.scrollHeight);
    await postPreviewTurn(page, sessionRef, "保持当前阅读位置");
    blockCount += 2;
    await expect.poll(async () => await transcriptBlockCount(page, sessionRef)).toBe(blockCount);
    await expect
      .poll(async () => await transcript.evaluate((element) => element.scrollHeight))
      .toBeGreaterThan(previousScrollHeight);
    await expect.poll(async () => await transcript.evaluate((element) => element.scrollTop)).toBe(0);
    await expect(page.getByRole("button", { name: "跳到最新消息" })).toBeVisible();
    await page.getByRole("button", { name: "跳到最新消息" }).click();
    await expect.poll(async () => await bottomDistance(transcript)).toBeLessThanOrEqual(2);
  } finally {
    await page.close();
  }
}

async function verifyExternalTuiRefresh(browser: Awaited<ReturnType<typeof chromium.launch>>, previewOrigin: string) {
  const page = await browser.newPage();
  try {
    const initialEventBatch = page.waitForResponse(
      (response) => new URL(response.url()).pathname === "/client/v1/events/batch",
    );
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await initialEventBatch;
    await expect(page.getByText("来自 Codex TUI 的外部消息。", { exact: true })).toHaveCount(0);
    await page.evaluate(async () => await fetch("/__preview/external-tui-turn", { method: "POST" }));
    await page.getByRole("button", { name: "刷新全部 Session" }).click();
    await expect(page.getByText("来自 Codex TUI 的外部消息。", { exact: true })).toBeVisible({ timeout: 5_000 });
    await expect(page.getByText("这条回复应在刷新 Session 后同步到 Web。", { exact: true })).toBeVisible();
  } finally {
    await page.close();
  }
}

async function verifyTranscriptPresentation(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage();
  try {
    await page.goto(previewOrigin);
    const navigation = page.locator(".session-nav");
    await navigation.getByText("clawchat-plugin-connect", { exact: true }).click();
    await navigation.getByText("App Server 与 Web Client", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();

    const transcript = page.locator(".transcript-scroll");
    await expect(transcript.getByText("Agent", { exact: true })).toHaveCount(0);
    await postPreviewTurn(page, "ABCDEFGH", "问题一\n问题二\n问题三");
    const multilineMessage = transcript.locator('[data-block-type="message"]').filter({ hasText: "问题一" });
    await expect(multilineMessage).toHaveCount(1);
    await expect.poll(async () => await multilineMessage.innerText()).toContain("问题一\n问题二\n问题三");
    const group = transcript
      .locator("[data-transcript-group]")
      .filter({ hasText: "App Server 已成为 Codex 的唯一生产协议" });
    await expect(group).toHaveCount(1);
    await expect(group.getByRole("separator")).toHaveCount(1);
    const tools = group.locator('[data-block-type="tool-group"]');
    await expect(tools).toHaveCount(1);
    const toolsToggle = tools.getByRole("button").first();
    await expect(toolsToggle).toHaveAttribute("aria-expanded", "false");
    await toolsToggle.click();
    await expect(toolsToggle).toHaveAttribute("aria-expanded", "true");
    await expect(tools.getByText("Command", { exact: true })).toBeVisible();
    await expect(tools.getByText("web/src/main.tsx", { exact: true })).toBeVisible();
    const unknown = group.locator('[data-block-type="unknown"]');
    await expect(unknown.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  } finally {
    await page.close();
  }
}

async function postPreviewTurn(page: Page, sessionRef: string, prompt: string) {
  const response = await page.evaluate(
    async ({ ref, text }) => {
      const body = new FormData();
      const submissionId = crypto.randomUUID();
      body.append("prompt", text);
      const request = await fetch(`/client/v1/sessions/${ref}/turn-submissions/${submissionId}`, {
        method: "POST",
        body,
      });
      return { ok: request.ok, status: request.status };
    },
    { ref: sessionRef, text: prompt },
  );
  assert(response.ok, `preview turn failed: ${response.status}`);
}

async function bottomDistance(transcript: Locator): Promise<number> {
  return await transcript.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop);
}

async function transcriptBlockCount(page: Page, sessionRef: string): Promise<number> {
  return await page.evaluate(async (ref) => {
    const response = await fetch(`/client/v1/sessions/${ref}/transcript?limit=100`);
    const body = (await response.json()) as { blocks?: unknown[] };
    return body.blocks?.length ?? 0;
  }, sessionRef);
}

async function verifyEmbeddedMobileNavigationDoesNotOverflow(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const page = await browser.newPage({ viewport: { width: 442, height: 704 } });
  try {
    await page.goto(previewOrigin);
    await page.getByTestId("mobile-nav-toggle").click();
    const navigationOverlay = page.locator(".astryx-mobile-nav");
    await expect(navigationOverlay).toBeVisible();
    await navigationOverlay.evaluate((element) => {
      (element as HTMLElement).style.width = "360px";
      (element as HTMLElement).style.maxWidth = "360px";
    });
    const hostWidth = await navigationOverlay.evaluate((element) => element.clientWidth);
    const drawerWidth = await navigationOverlay.locator(":scope > div").evaluate((element) => element.clientWidth);
    assert(
      drawerWidth <= hostWidth,
      `embedded mobile navigation drawer must fit its host: ${JSON.stringify({
        hostWidth,
        drawerWidth,
      })}`,
    );
  } finally {
    await page.close();
  }
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

    await dialog.getByText("clawchat-plugin-connect", { exact: true }).first().click();
    await dialog.getByText("App Server 与 Web Client", { exact: true }).click();
    await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
    await expect(dialog).toHaveCount(0);

    await page.getByTestId("mobile-nav-toggle").click();
    await expect(dialog).toBeVisible();
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

    await createDialog.getByRole("textbox", { name: /^名称/u }).fill("Small-window Session");
    await submit.click();
    await expect(page.getByRole("heading", { name: "Small-window Session" })).toBeVisible();
    await expect(createDialog).not.toBeVisible();

    const composerInput = page.locator(".session-composer [contenteditable='true']");
    await composerInput.click();
    await page.keyboard.type("小窗口输入");
    await expect(composerInput).toHaveText("小窗口输入");

    await page.getByTestId("mobile-nav-toggle").click();
    await expect(dialog).toBeVisible();
    await page.getByRole("button", { name: "新建 Session" }).click();
    await expect(createDialog).toBeVisible();
    await expect(createDialog.getByRole("button", { name: "创建 Session" })).toBeEnabled();
  } finally {
    await page.close();
  }
}

async function verifyResponsiveArtifactWorkspace(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
) {
  const viewports = [
    { width: 320, height: 568 },
    { width: 390, height: 844 },
    { width: 442, height: 704 },
    { width: 720, height: 900 },
    { width: 721, height: 900 },
    { width: 1024, height: 768 },
    { width: 1440, height: 900 },
  ];
  for (const viewport of viewports) {
    await verifyArtifactWorkspaceAtViewport(browser, previewOrigin, viewport);
  }
}

async function verifyArtifactWorkspaceAtViewport(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  previewOrigin: string,
  viewport: { width: number; height: number },
) {
  const page = await browser.newPage({ viewport });
  try {
    await page.goto(`${previewOrigin}/sessions/ABCDEFGH`);
    await page.getByRole("link", { name: "打开 Artifact 移动端测试" }).click();
    await expect(page.getByRole("heading", { name: "Mobile Artifact preview" })).toBeVisible();
    if (viewport.width <= 720) await expect(page.locator(".session-composer-surface")).toBeHidden();
    else await expect(page.locator(".session-composer-surface")).toBeVisible();

    await page.getByRole("link", { name: "Open TypeScript" }).click();
    await expect(page.getByText('export const mobileArtifact = "ready";')).toBeVisible();
    if (viewport.width <= 720) {
      await expect(page.locator(".artifact-tab-strip")).toBeHidden();
      await expect(page.locator(".artifact-mobile-controls")).toBeVisible();
      await expect(page.getByRole("button", { name: "← 对话" })).toBeVisible();
      await page.getByRole("button", { name: "已打开 (2)" }).click();
      const sheet = page.getByRole("dialog").filter({ hasText: "已打开文件" });
      await expect(sheet).toBeVisible();
      await expect(sheet.getByText("artifact-preview.md", { exact: true })).toBeVisible();
      await expect(sheet.getByText("artifact-preview.ts", { exact: true })).toBeVisible();
      await sheet.evaluate(async (element) => {
        await Promise.all(element.getAnimations().map((animation) => animation.finished));
      });
      const sheetBox = await sheet.boundingBox();
      assert(sheetBox, "mobile Artifact sheet must have a bounding box");
      assert(
        sheetBox.x >= 7 && sheetBox.x <= 9 && sheetBox.width >= viewport.width - 18,
        `mobile Artifact sheet must use the available viewport width: ${JSON.stringify({ sheetBox, viewport })}`,
      );
      assert(
        sheetBox.y + sheetBox.height <= viewport.height && sheetBox.y + sheetBox.height >= viewport.height - 12,
        `mobile Artifact sheet must stay attached to the viewport bottom: ${JSON.stringify({ sheetBox, viewport })}`,
      );
      await sheet.getByRole("button", { name: "关闭已打开文件" }).click();
      await page.getByRole("button", { name: "← 对话" }).click();
      await expect(page.getByRole("button", { name: "← 对话" })).toHaveCount(0);
    } else {
      await expect(page.locator(".artifact-tab-strip")).toBeVisible();
      await expect(page.locator(".artifact-mobile-controls")).toBeHidden();
      await expect(page.getByRole("tab", { name: "artifact-preview.ts" })).toBeVisible();
      await expect(page.getByRole("tab", { name: "App Server 与 Web Client" })).toHaveCount(0);
    }
    await expect(page.locator(".session-composer-surface")).toBeVisible();
    const geometry = await page.evaluate(() => ({
      client: document.documentElement.clientWidth,
      scroll: document.documentElement.scrollWidth,
    }));
    assert.equal(
      geometry.scroll,
      geometry.client,
      `Artifact Workspace must not overflow its viewport: ${JSON.stringify({ geometry, viewport })}`,
    );
  } finally {
    await page.close();
  }
}

async function verifyLongSessionNameDoesNotOverflow(page: Page) {
  const longName = "$grill-with-docs 根据https://github.com/clawling/clawnest-liveware，connect web可以使用liveware "
    .repeat(2)
    .trim();
  const response = await page.evaluate(async (name) => {
    const projects = (await (await fetch("/client/v1/projects")).json()) as Array<{
      workspaceId: string;
      name: string;
    }>;
    const workspaceId = projects.find((project) => project.name === "clawchat-plugin-connect")?.workspaceId;
    const request = await fetch("/client/v1/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bindingId: "codex",
        workspaceId,
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

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Could not allocate a preview server port");
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return address.port;
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

import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { access, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { type Browser, chromium, expect, type Page } from "@playwright/test";

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
    const context = await browser.newContext({ locale: "zh-CN" });
    const page = await context.newPage();
    await page.goto(`${origin}/?lang=JA`);

    await expect(page.getByRole("heading", { name: "セッションを選択" })).toBeVisible();
    await expect(
      page.getByText(
        "左側には、この Agent Binding で検出できるすべての Project と Non-Project Session が表示されます。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText(
        "Connect Client からのメッセージはこの Agent Binding にのみ送信され、ClawChat には同期されません。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(page.getByRole("button", { name: "すべての Session を更新" })).toBeVisible();
    await expect(page.getByRole("button", { name: "設定" })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Session を検索" })).toBeVisible();
    await expect(page.getByRole("button", { name: "新しい Session" })).toBeVisible();
    await expect(page.getByRole("img", { name: "接続済み" })).toBeVisible();
    await expect(page.getByRole("link", { name: "本文へスキップ" })).toHaveAttribute("href", "#astryx-app-shell-main");
    assert.equal(await page.locator("html").getAttribute("lang"), "ja");
    await page.evaluate(() => {
      document.documentElement.dataset.localeTestDocument = "original";
    });

    await page.getByRole("button", { name: "設定" }).click();
    await expect(page).toHaveURL(`${origin}/settings?lang=JA`);
    assert.equal(await page.locator("html").getAttribute("data-locale-test-document"), "original");

    await page.getByRole("link", { name: "ClawChat Connect" }).click();
    await expect(page).toHaveURL(`${origin}/?lang=JA`);
    assert.equal(await page.locator("html").getAttribute("data-locale-test-document"), "original");

    await page.getByText("Non-Project scratch", { exact: true }).click();
    await expect(page).toHaveURL(`${origin}/sessions/JKLMNPQR?lang=JA`);
    assert.equal(await page.locator("html").getAttribute("data-locale-test-document"), "original");
    await page.getByRole("link", { name: "ClawChat Connect" }).click();
    await page.evaluate(() => {
      Object.defineProperty(navigator, "languages", { configurable: true, value: ["ko-KR"] });
    });
    await page.getByRole("button", { name: "設定" }).click();
    await page.getByRole("button", { name: "Session に戻る" }).click();
    await expect(page.getByRole("heading", { name: "セッションを選択" })).toBeVisible();
    assert.equal(await page.locator("html").getAttribute("lang"), "ja");

    await page.setViewportSize({ width: 600, height: 800 });
    await expect(page.getByRole("button", { name: "ナビゲーションを開く" })).toBeVisible();

    await context.close();
    await verifyLocaleResolution(browser, origin);
    await verifyLocalizedEntryStates(browser, origin);
    await verifyLocalizedTurnSubmission(browser, origin);
    await verifyLocalizedSettingsAndProjects(browser, origin);
    await verifyLocalizedSessionLifecycle(browser, origin);
    await verifyLocalizedTranscriptInteractionsAndArtifacts(browser, origin);
    process.stdout.write("Verified Connect Client locale resolution, shell copy, states, and SPA retention.\n");
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  await server.exited;
}

async function verifyLocalizedTranscriptInteractionsAndArtifacts(browser: Browser, previewOrigin: string) {
  const context = await browser.newContext({ locale: "en-US", timezoneId: "UTC" });
  const page = await context.newPage();
  const interactionRequests: unknown[] = [];
  page.on("request", (request) => {
    if (/\/client\/v1\/runtime-interactions\/[^/]+\/respond$/u.test(new URL(request.url()).pathname)) {
      interactionRequests.push(request.postDataJSON());
    }
  });
  await page.route("**/client/v1/sessions/ABCDEFGH/transcript?*", async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as { blocks?: Array<Record<string, unknown>> };
    await route.fulfill({
      response,
      json: {
        ...body,
        blocks: body.blocks?.map((block) => ({
          ...block,
          createdAt: "2026-08-04T12:34:00.000Z",
          updatedAt: "2026-08-04T12:34:00.000Z",
        })),
      },
    });
  });

  await page.goto(`${previewOrigin}/sessions/ABCDEFGH?lang=en-US`);
  await expect(page.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
  await expect(page.getByText("ClawChat direct message from Colin:", { exact: false })).toBeVisible();
  await expect(page.getByText("实现 app-server 后再构建 Web。", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Execution plan" })).toBeVisible();
  await expect(page.getByText("迁移 app-server", { exact: false })).toBeVisible();
  await expect(page.getByText("bun test", { exact: true })).toBeVisible();
  await expect(page.locator(".transcript-group-divider").first()).toContainText("Aug 4, 2026, 12:34 PM");

  const approval = page.locator(".runtime-interaction-card").filter({ hasText: "允许 Codex 更新本地 Connect？" });
  await expect(approval).toContainText("Working directory:");
  await expect(approval).toContainText("该命令会替换本机安装的 Connect 并重启服务。");
  await approval.getByRole("button", { name: "拒绝", exact: true }).click();
  await expect(approval).toContainText("Resolved · Connect Client");
  assert.equal(interactionRequests.length, 1);
  assert.deepEqual(withoutRequestId(interactionRequests[0]), { optionId: "deny" });

  await page.getByRole("link", { name: "打开 Artifact 移动端测试" }).click();
  await expect(page.getByRole("tablist", { name: "Open files" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Mobile Artifact preview" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Open TypeScript" })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download" })).toBeVisible();
  await page.getByRole("link", { name: "Open TypeScript" }).click();
  await expect(page.getByText('export const mobileArtifact = "ready";', { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Copy code" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Close artifact-preview.ts" })).toBeVisible();
  assert.equal(page.url(), `${previewOrigin}/sessions/ABCDEFGH?lang=en-US`);
  await context.close();
}

async function verifyLocalizedSessionLifecycle(browser: Browser, previewOrigin: string) {
  const creationContext = await browser.newContext({ locale: "en-US" });
  const creationPage = await creationContext.newPage();
  const createRequests: unknown[] = [];
  creationPage.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === "/client/v1/sessions") {
      createRequests.push(request.postDataJSON());
    }
  });
  await creationPage.goto(`${previewOrigin}/?lang=es-ES`);
  await creationPage.getByRole("button", { name: "Nueva Session" }).click();
  const createDialog = creationPage.getByRole("dialog");
  await expect(createDialog.getByRole("heading", { name: "Nueva Session" })).toBeVisible();
  await createDialog.getByRole("textbox", { name: /^Nombre/u }).fill("Sesión exacta λ");
  await expect(createDialog.getByRole("combobox", { name: "Modo" })).toContainText("Modo predeterminado");
  await expect(createDialog.getByRole("combobox", { name: "Modelo" })).toContainText(
    "Heredar el valor predeterminado de Agent Binding / Runtime",
  );
  await createDialog.getByRole("button", { name: "Crear Session" }).click();
  await expect(creationPage.getByRole("heading", { name: "Sesión exacta λ" })).toBeVisible();
  assert.match(creationPage.url(), /\/sessions\/[A-Z2-9]{8}\?lang=es-ES$/u);
  assert.equal(createRequests.length, 1, "localized Session creation must issue one semantic request");
  assert.deepEqual(withoutRequestId(createRequests[0]), {
    bindingId: "codex",
    workspace: { kind: "none" },
    name: "Sesión exacta λ",
    mode: null,
    model: null,
    reasoningEffort: null,
  });
  await creationContext.close();

  const lifecycleContext = await browser.newContext({ locale: "en-US" });
  const lifecyclePage = await lifecycleContext.newPage();
  let archived = false;
  let archiveAttempts = 0;
  const lifecycleRequests: Array<{ method: string; pathname: string; body: unknown }> = [];
  await lifecyclePage.route(/\/client\/v1\/sessions\/ABCDEFGH(?:\?refresh=1)?$/u, async (route) => {
    if (route.request().method() !== "GET") return await route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({
      response,
      json: {
        ...body,
        isArchived: archived,
        allowedActions: archived ? ["read", "unarchive", "delete"] : ["read", "send", "archive", "delete"],
      },
    });
  });
  for (const action of ["archive", "unarchive"] as const) {
    await lifecyclePage.route(`**/client/v1/sessions/ABCDEFGH/${action}`, async (route) => {
      lifecycleRequests.push({
        method: route.request().method(),
        pathname: new URL(route.request().url()).pathname,
        body: route.request().postDataJSON(),
      });
      if (action === "archive" && archiveAttempts++ > 0) {
        await route.fulfill({
          status: 409,
          contentType: "application/json",
          body: JSON.stringify({
            error: { code: "session-state-conflict", message: "Session is already archived", retryable: false },
          }),
        });
        return;
      }
      archived = action === "archive";
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ sessionRef: "ABCDEFGH", archived }),
      });
    });
  }
  await lifecyclePage.route("**/client/v1/sessions/ABCDEFGH", async (route) => {
    if (route.request().method() !== "DELETE") return await route.fallback();
    lifecycleRequests.push({
      method: route.request().method(),
      pathname: new URL(route.request().url()).pathname,
      body: route.request().postDataJSON(),
    });
    await route.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({
        error: { code: "runtime-bridge-failed", message: "Runtime bridge Ω", retryable: true, diagnosticRef: "diag-λ" },
      }),
    });
  });
  await lifecyclePage.goto(`${previewOrigin}/sessions/ABCDEFGH?lang=ko-KR`);
  await expect(lifecyclePage.getByRole("heading", { name: "App Server 与 Web Client" })).toBeVisible();
  await lifecyclePage.getByRole("button", { name: "Session 작업" }).click();
  await lifecyclePage.getByRole("menuitem", { name: "Session 보관" }).click();
  await expect(lifecyclePage.getByText("이 Session은 보관됨", { exact: true })).toBeVisible();
  await lifecyclePage.getByRole("button", { name: "Session 작업" }).click();
  await lifecyclePage.getByRole("menuitem", { name: "Session 복원" }).click();
  await expect(lifecyclePage.getByRole("status").filter({ hasText: "Session이 복원됨" })).toBeVisible();
  await lifecyclePage.getByRole("button", { name: "Session 작업" }).click();
  await lifecyclePage.getByRole("menuitem", { name: "Session 보관" }).click();
  const conflict = lifecyclePage.getByRole("alert").filter({ hasText: "Session 작업 실패" });
  await expect(conflict).toContainText("작업이 끝나기 전에 Session이 변경되었습니다");
  await expect(conflict).not.toContainText("Session is already archived");
  await lifecyclePage.getByRole("button", { name: "Session 작업" }).click();
  await lifecyclePage.getByRole("menuitem", { name: "Session 영구 삭제" }).click();
  const deleteDialog = lifecyclePage.getByRole("alertdialog");
  await expect(deleteDialog.getByRole("heading", { name: "이 Session을 영구 삭제할까요?" })).toBeVisible();
  await expect(deleteDialog).toContainText("하위 Thread는 Connect에 의해 추가로 연쇄 삭제되지 않습니다.");
  await deleteDialog.getByRole("button", { name: "영구 삭제" }).click();
  await expect(deleteDialog).toBeVisible();
  await deleteDialog.getByRole("button", { name: "취소" }).click();
  await expect(deleteDialog).toHaveCount(0);
  const unknownFailure = lifecyclePage.getByRole("alert").filter({ hasText: "Session 작업 실패" });
  await expect(unknownFailure).toContainText("Runtime bridge Ω");
  await expect(unknownFailure).toContainText("diag-λ");
  assert.equal(lifecyclePage.url(), `${previewOrigin}/sessions/ABCDEFGH?lang=ko-KR`);
  assert.deepEqual(
    lifecycleRequests.map(({ method, pathname, body }) => ({ method, pathname, body: withoutRequestId(body) })),
    [
      { method: "POST", pathname: "/client/v1/sessions/ABCDEFGH/archive", body: {} },
      { method: "POST", pathname: "/client/v1/sessions/ABCDEFGH/unarchive", body: {} },
      { method: "POST", pathname: "/client/v1/sessions/ABCDEFGH/archive", body: {} },
      { method: "DELETE", pathname: "/client/v1/sessions/ABCDEFGH", body: {} },
    ],
  );
  await lifecycleContext.close();
}

async function verifyLocalizedSettingsAndProjects(browser: Browser, previewOrigin: string) {
  const projectDirectory = await mkdtemp(`${process.env.TMPDIR ?? "/tmp"}/connect-localized-project-`);
  const canonicalProjectDirectory = await realpath(projectDirectory);
  const context = await browser.newContext({ locale: "en-US" });
  const page = await context.newPage();
  const preferenceRequests: unknown[] = [];
  const projectRequests: Array<{ method: string; pathname: string; body: unknown }> = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (request.method() === "PATCH" && url.pathname === "/client/v1/bindings/codex/preferences") {
      preferenceRequests.push(request.postDataJSON());
    }
    if (url.pathname === "/client/v1/projects" && request.method() === "POST") {
      projectRequests.push({ method: request.method(), pathname: url.pathname, body: request.postDataJSON() });
    }
    if (url.pathname.startsWith("/client/v1/projects/") && request.method() === "DELETE") {
      projectRequests.push({ method: request.method(), pathname: url.pathname, body: request.postDataJSON() });
    }
  });

  try {
    await page.goto(`${previewOrigin}/?lang=ja-JP`);
    await page.getByRole("button", { name: "設定" }).click();
    await expect(page).toHaveURL(`${previewOrigin}/settings?lang=ja-JP`);
    await expect(page.getByRole("heading", { name: "安全な設定" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Codex · Local" })).toBeVisible();
    await expect(page.getByText("codex", { exact: true })).toBeVisible();

    await page.getByRole("textbox", { name: "表示名" }).fill("Binding 名 λ");
    await chooseLocalizedOption(page, "モデル", "Deep model (gpt-deep)");
    await chooseLocalizedOption(page, "推論レベル", "xhigh");
    await chooseLocalizedOption(page, "ClawChat での出力表示", "すべて");
    await page.getByRole("button", { name: "設定を保存" }).click();
    await expect(page.getByRole("status").filter({ hasText: "設定を保存しました" })).toBeVisible();
    assert.deepEqual(withoutRequestId(preferenceRequests.at(-1)), {
      displayName: "Binding 名 λ",
      model: "gpt-deep",
      modelReasoningEffort: "xhigh",
      outputVisibility: "full",
    });

    await page.getByRole("button", { name: "ディレクトリを選択" }).click();
    const directoryDialog = page.getByRole("dialog");
    await expect(directoryDialog.getByRole("heading", { name: "Project ディレクトリを選択" })).toBeVisible();
    await directoryDialog.getByRole("textbox", { name: "ホストの絶対パス" }).fill(canonicalProjectDirectory);
    await directoryDialog.getByRole("button", { name: "開く", exact: true }).click();
    await expect(directoryDialog.getByText(canonicalProjectDirectory, { exact: true }).last()).toBeVisible();
    await directoryDialog.getByRole("button", { name: "このディレクトリを選択" }).click();
    await expect(page.getByText(canonicalProjectDirectory, { exact: true }).first()).toBeVisible();
    await page.getByRole("button", { name: "Project を追加" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Project を追加しました" })).toBeVisible();
    assert.deepEqual(withoutRequestId(projectRequests[0]?.body), {
      directory: { kind: "existing-directory", rootPath: canonicalProjectDirectory },
    });

    const projectName = canonicalProjectDirectory.split("/").at(-1) ?? canonicalProjectDirectory;
    const registeredProject = await page.evaluate(async (rootPath) => {
      const projects = (await (await fetch("/client/v1/projects")).json()) as Array<{
        workspaceId: string;
        name: string;
        rootPath: string;
      }>;
      return projects.find((project) => project.rootPath === rootPath) ?? null;
    }, canonicalProjectDirectory);
    assert(registeredProject, "localized Project add must preserve the registered Project view");
    const projectRow = page.getByRole("listitem").filter({ hasText: canonicalProjectDirectory });
    await expect(projectRow.getByText(projectName, { exact: true })).toBeVisible();
    await expect(projectRow.getByText(`Workspace ID：${registeredProject.workspaceId}`, { exact: true })).toBeVisible();
    await projectRow.getByRole("button", { name: `${projectName} を削除` }).click();
    const confirmation = page.getByRole("alertdialog");
    await expect(confirmation.getByRole("heading", { name: `${projectName} を削除しますか？` })).toBeVisible();
    await expect(confirmation).toContainText(canonicalProjectDirectory);
    await confirmation.getByRole("button", { name: "Project を削除" }).click();
    await expect(page.getByRole("status").filter({ hasText: "Project を削除しました" })).toContainText(projectName);
    assert.equal(projectRequests[1]?.method, "DELETE");
    assert.equal(projectRequests[1]?.pathname, `/client/v1/projects/${registeredProject.workspaceId}`);
    assert.deepEqual(withoutRequestId(projectRequests[1]?.body), {});
    assert.equal(page.url(), `${previewOrigin}/settings?lang=ja-JP`);
  } finally {
    await context.close();
    await rm(projectDirectory, { recursive: true, force: true });
  }
}

async function chooseLocalizedOption(page: Page, label: string, option: string) {
  await page.getByRole("combobox", { name: label }).click();
  await page.getByRole("option", { name: option, exact: true }).click();
}

async function verifyLocaleResolution(browser: Browser, previewOrigin: string) {
  const cases = [
    { query: "zh", browserLocale: "en-US", locale: "zh-Hans", title: "选择一个 Session" },
    { query: "ZH_hK", browserLocale: "en-US", locale: "zh-Hant", title: "選擇一個 Session" },
    { query: "en-GB", browserLocale: "zh-CN", locale: "en", title: "Select a Session" },
    { query: "ja-JP", browserLocale: "en-US", locale: "ja", title: "セッションを選択" },
    { query: "es_419", browserLocale: "en-US", locale: "es", title: "Selecciona una Session" },
    { query: "ko-KR", browserLocale: "en-US", locale: "ko", title: "Session 선택" },
    { query: "not-a-locale", browserLocale: "es-MX", locale: "es", title: "Selecciona una Session" },
    { query: "en-12", browserLocale: "zh-CN", locale: "zh-Hans", title: "选择一个 Session" },
    { query: "ja-00", browserLocale: "ko-KR", locale: "ko", title: "Session 선택" },
    { query: "ko-abc", browserLocale: "es-MX", locale: "es", title: "Selecciona una Session" },
    { query: null, browserLocale: "ko-KR", locale: "ko", title: "Session 선택" },
    { query: null, browserLocale: "fr-FR", locale: "en", title: "Select a Session" },
  ] as const;

  for (const testCase of cases) {
    const context = await browser.newContext({ locale: testCase.browserLocale });
    const page = await context.newPage();
    const url = testCase.query === null ? previewOrigin : `${previewOrigin}/?lang=${testCase.query}`;
    await page.goto(url);
    await expect(page.getByRole("heading", { name: testCase.title })).toBeVisible();
    assert.equal(await page.locator("html").getAttribute("lang"), testCase.locale);
    await context.close();
  }

  const orderedContext = await browser.newContext({ locale: "fr-FR" });
  await orderedContext.addInitScript(() => {
    Object.defineProperty(navigator, "languages", {
      configurable: true,
      value: ["fr-FR", "ZH_sG", "ko-KR"],
    });
  });
  const orderedPage = await orderedContext.newPage();
  await orderedPage.goto(previewOrigin);
  await expect(orderedPage.getByRole("heading", { name: "选择一个 Session" })).toBeVisible();
  assert.equal(await orderedPage.locator("html").getAttribute("lang"), "zh-Hans");
  await orderedContext.close();
}

async function verifyLocalizedTurnSubmission(browser: Browser, previewOrigin: string) {
  const queueContext = await browser.newContext({ locale: "en-US" });
  const queuePage = await queueContext.newPage();
  const queuedTurns: Array<Record<string, unknown>> = [];
  let submittedBody = "";
  await queuePage.route(/\/client\/v1\/events/u, async (route) => await route.abort("blockedbyclient"));
  await queuePage.route(/\/client\/v1\/sessions\/JKLMNPQR(?:\?refresh=1)?$/u, async (route) => {
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...body, status: "running", queuedTurns } });
  });
  await queuePage.route(/\/client\/v1\/sessions\/JKLMNPQR\/turn-submissions\//u, async (route) => {
    submittedBody = route.request().postData() ?? "";
    await Bun.sleep(400);
    queuedTurns.push({
      turnId: "localized-queued-turn",
      prompt: "/grill-with-docs evaluación exacta λ",
      selection: { kind: "skill", id: "codex:grill-with-docs", name: "grill-with-docs" },
      attachments: [],
      createdAt: new Date(0).toISOString(),
    });
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, turnId: "localized-queued-turn", sessionRef: "JKLMNPQR" }),
    });
  });
  await queuePage.route(
    /\/client\/v1\/sessions\/JKLMNPQR\/queued-turns\/localized-queued-turn\/withdraw$/u,
    async (route) => {
      queuedTurns.splice(0);
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ cancelled: true, turnId: "localized-queued-turn", sessionRef: "JKLMNPQR" }),
      });
    },
  );
  await queuePage.goto(`${previewOrigin}/sessions/JKLMNPQR?lang=es-ES`);
  const modelTrigger = queuePage.getByRole("button", {
    name: /Configuración del modelo: gpt-removed · high/u,
  });
  await expect(modelTrigger).toBeVisible();
  await modelTrigger.click();
  const modelDialog = queuePage.getByRole("dialog", { name: "Configuración del modelo de Session" });
  await expect(modelDialog.getByText("Modelo no disponible", { exact: true })).toBeVisible();
  await expect(modelDialog.getByRole("combobox", { name: "Modelo de Session" })).toContainText(
    "gpt-removed (no disponible)",
  );
  await queuePage.keyboard.press("Escape");

  const input = queuePage.getByRole("combobox", { name: "Entrada de mensaje" });
  await input.fill("/gr");
  const picker = queuePage.getByRole("listbox", { name: "Comandos y Skills" });
  const skill = picker.getByRole("option", { name: /grill-with-docs/u });
  await expect(skill).toContainText("结合官方文档追问并检验方案");
  await skill.click();
  await input.fill("/grill-with-docs evaluación exacta λ");
  await queuePage.getByRole("button", { name: "Enviar", exact: true }).click();
  const queue = queuePage.locator(".composer-queue");
  await expect(queue).toContainText("/grill-with-docs evaluación exacta λ", { timeout: 250 });
  await expect(queue).toContainText("Enviando", { timeout: 250 });
  await expect(queue.getByRole("button", { name: "Retirar y editar" })).toBeVisible({ timeout: 2_000 });
  assert.match(submittedBody, /name="prompt"\r\n\r\n\/grill-with-docs evaluación exacta λ/u);
  assert.match(submittedBody, /name="selectionKind"\r\n\r\nskill/u);
  assert.match(submittedBody, /name="selectionId"\r\n\r\ncodex:grill-with-docs/u);
  assert.match(submittedBody, /name="selectionName"\r\n\r\ngrill-with-docs/u);
  await queue.getByRole("button", { name: "Retirar y editar" }).click();
  await expect(input).toHaveText("/grill-with-docs evaluación exacta λ");
  await queuePage.locator(".composer-file-input").setInputFiles({
    name: "diagnóstico-原样.exe",
    mimeType: "application/x-msdownload",
    buffer: Buffer.from("preserve attachment bytes"),
  });
  await expect(queuePage.getByText(/diagnóstico-原样\.exe/u)).toBeVisible();
  assert.equal(queuePage.url(), `${previewOrigin}/sessions/JKLMNPQR?lang=es-ES`);
  await queuePage.unrouteAll({ behavior: "ignoreErrors" });
  await queueContext.close();

  const cancelContext = await browser.newContext({ locale: "en-US" });
  const cancelPage = await cancelContext.newPage();
  await cancelPage.route(/\/client\/v1\/sessions\/JKLMNPQR\/turn-submissions\//u, async (route) => {
    if (route.request().method() === "DELETE") {
      await route.fulfill({
        status: 409,
        contentType: "application/json",
        body: JSON.stringify({
          error: { code: "submission-cancelled", message: "raw cancellation", retryable: false },
        }),
      });
      return;
    }
    await Bun.sleep(2_000);
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ accepted: true, turnId: "too-late", sessionRef: "JKLMNPQR" }),
    });
  });
  await cancelPage.goto(`${previewOrigin}/sessions/JKLMNPQR?lang=ja-JP`);
  const cancelInput = cancelPage.getByRole("combobox", { name: "メッセージ入力" });
  await cancelInput.fill("ユーザーの原文 λ /literal");
  await cancelPage.getByRole("button", { name: "送信", exact: true }).click();
  await cancelPage.getByRole("button", { name: "送信をキャンセル" }).click();
  await expect(cancelPage.getByRole("alert")).toContainText("送信をキャンセルしました。");
  await expect(cancelInput).toHaveText("ユーザーの原文 λ /literal");
  assert.equal(cancelPage.url(), `${previewOrigin}/sessions/JKLMNPQR?lang=ja-JP`);
  await cancelPage.unrouteAll({ behavior: "ignoreErrors" });
  await cancelContext.close();
}

async function verifyLocalizedEntryStates(browser: Browser, previewOrigin: string) {
  const loadingContext = await browser.newContext();
  const loadingPage = await loadingContext.newPage();
  await loadingPage.route("**/client/v1/bootstrap", async (route) => {
    await Bun.sleep(500);
    await route.continue();
  });
  await loadingPage.goto(`${previewOrigin}/?lang=ja`);
  await expect(loadingPage.getByText("Connect Service に接続しています", { exact: true })).toBeVisible();
  await expect(loadingPage.getByRole("heading", { name: "セッションを選択" })).toBeVisible();
  await loadingContext.close();

  const failureContext = await browser.newContext();
  const failurePage = await failureContext.newPage();
  await failurePage.route("**/client/v1/bootstrap", (route) => route.abort());
  await failurePage.goto(`${previewOrigin}/?lang=es`);
  await expect(failurePage.getByRole("alert")).toContainText("No se puede conectar con Connect Service");
  await failureContext.close();

  const notFoundContext = await browser.newContext();
  const notFoundPage = await notFoundContext.newPage();
  await notFoundPage.goto(`${previewOrigin}/missing?lang=ko`);
  await expect(notFoundPage.getByRole("alert")).toContainText("페이지를 찾을 수 없음");
  await notFoundContext.close();

  const unsupportedContext = await browser.newContext();
  await unsupportedContext.addInitScript(() => {
    Reflect.deleteProperty(globalThis, "EventSource");
  });
  const unsupportedPage = await unsupportedContext.newPage();
  await unsupportedPage.goto(`${previewOrigin}/?lang=zh-Hant`);
  await expect(unsupportedPage.getByRole("alert")).toContainText("無法執行 Connect Client");
  await expect(unsupportedPage.getByRole("alert")).toContainText("目前的瀏覽器不支援 Server-Sent Events。");
  await unsupportedContext.close();

  const offlineCatalogContext = await browser.newContext();
  const requestedUrls: string[] = [];
  const offlineCatalogPage = await offlineCatalogContext.newPage();
  offlineCatalogPage.on("request", (request) => requestedUrls.push(request.url()));
  await offlineCatalogPage.goto(`${previewOrigin}/?lang=ko`);
  await expect(offlineCatalogPage.getByRole("heading", { name: "Session 선택" })).toBeVisible();
  assert(
    requestedUrls.every((url) => !/^https?:/u.test(url) || new URL(url).origin === previewOrigin),
    `locale rendering must not request an external origin: ${JSON.stringify(requestedUrls)}`,
  );
  assert(
    requestedUrls.every((url) => !/(?:locale|translation|crowdin|\.json(?:\?|$))/iu.test(new URL(url).pathname)),
    `locale rendering must use statically bundled catalogs: ${JSON.stringify(requestedUrls)}`,
  );
  assert(
    requestedUrls.every((url) => !/figtree/iu.test(new URL(url).pathname)),
    `locale rendering must use Astryx system-font defaults: ${JSON.stringify(requestedUrls)}`,
  );
  await offlineCatalogContext.close();
}

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert(address && typeof address === "object", "available port probe must bind a TCP address");
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The preview server is still starting.
    }
    await Bun.sleep(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function localChromiumPath(): Promise<string | undefined> {
  const candidates = [
    process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
  ].filter((candidate): candidate is string => Boolean(candidate));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Try the next local browser before Playwright's managed binary.
    }
  }
  return undefined;
}

function withoutRequestId(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const { requestId: _requestId, ...rest } = value as Record<string, unknown>;
  return rest;
}

import { strict as assert } from "node:assert";
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { chromium, expect, type Browser } from "@playwright/test";

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
        "左側には、この Connect バインディングで検出できるすべての Project と Non-Project Session が表示されます。",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByText("Web メッセージは Connect バインディングの Agent にのみ送信され、ClawChat には同期されません。", {
        exact: true,
      }),
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
    process.stdout.write("Verified Connect Client locale resolution, shell copy, states, and SPA retention.\n");
  } finally {
    await browser.close();
  }
} finally {
  server.kill("SIGTERM");
  await server.exited;
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

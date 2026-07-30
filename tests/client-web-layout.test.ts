import { describe, expect, it } from "bun:test";

const stylesheetUrl = new URL("../web/src/styles/index.css", import.meta.url);
const sessionRouteUrl = new URL("../web/src/routes/sessions.$sessionRef.tsx", import.meta.url);
const sessionComposerUrl = new URL("../web/src/features/composer/SessionComposer.tsx", import.meta.url);
const iconsUrl = new URL("../web/src/components/icons.tsx", import.meta.url);
const appShellUrl = new URL("../web/src/features/app-shell/ConnectAppShell.tsx", import.meta.url);
const transcriptBlockUrl = new URL("../web/src/features/transcript/TranscriptBlockView.tsx", import.meta.url);
const settingsPageUrl = new URL("../web/src/features/settings/SettingsPage.tsx", import.meta.url);

describe("Connect Client session layout", () => {
  it("keeps the transcript and composer in stable rows when the history warning is absent", async () => {
    const stylesheet = await Bun.file(stylesheetUrl).text();

    expect(cssRule(stylesheet, ".session-notices")).toContain("grid-row: 2");
    expect(cssRule(stylesheet, ".transcript-frame")).toContain("grid-row: 3");
    expect(cssRule(stylesheet, ".composer-region")).toContain("grid-row: 4");
  });

  it("reports partial and live-only transcript history with a deduplicated info toast", async () => {
    const source = await Bun.file(sessionRouteUrl).text();

    expect(source).toContain('import { useToast } from "@astryxdesign/core/Toast"');
    expect(source).toContain("uniqueID: `transcript-completeness:" + "$" + "{sessionRef}`");
    expect(source).toContain('collisionBehavior: "overwrite"');
    expect(source).toContain("部分工具执行细节可能缺失。");
    expect(source).toContain("仅显示 Connect 已同步的消息；此 Session 的早期 Runtime 历史不可用。");
    expect(source).not.toContain('title="历史消息可能不完整"');
    expect(source).not.toContain("本次运行期间捕获的消息");
  });

  it("keeps two-column Settings controls aligned by placing descriptions below the controls", async () => {
    const [source, stylesheet] = await Promise.all([Bun.file(settingsPageUrl).text(), Bun.file(stylesheetUrl).text()]);
    const controls = [...source.matchAll(/<(?:Selector|TextInput)\b[\s\S]*?\/>/gu)].map(([control]) => control);

    expect(source).toContain("function SettingsField({ children, description }");
    expect(source).toContain('<p className="settings-field-description">{description}</p>');
    expect(controls.every((control) => !control.includes("description="))).toBe(true);
    expect(source).toContain('<SettingsField description="默认值会跟随 Runtime Adapter');
    expect(source).toContain('<SettingsField description="Web 始终尽可能展示完整');
    expect(source).toContain('<SettingsField description="可选；用逗号分隔');
    expect(cssRule(stylesheet, ".settings-field")).toContain("align-content: start");
    expect(cssRule(stylesheet, ".settings-field-description")).toContain("margin: 0");
  });

  it("keeps model settings out of the Session header and inside the composer", async () => {
    const source = await Bun.file(sessionRouteUrl).text();
    const header = source.slice(source.indexOf('<header className="session-header">'), source.indexOf("</header>"));

    expect(header).not.toContain("<SessionModelControls");
    expect(source).toContain("modelControl={<SessionModelControls view={view} />}");
    expect(source).toContain('label="Session 模型设置"');
    expect(source).toContain('placement="above"');
  });

  it("moves Session workspace metadata from the header into the composer footer", async () => {
    const [source, composer, stylesheet] = await Promise.all([
      Bun.file(sessionRouteUrl).text(),
      Bun.file(sessionComposerUrl).text(),
      Bun.file(stylesheetUrl).text(),
    ]);
    const header = source.slice(source.indexOf('<header className="session-header">'), source.indexOf("</header>"));

    expect(header).not.toContain("view.workspaceName");
    expect(source).toContain("contextLabel={`${view.workspaceName");
    expect(composer).toContain("contextLabel: string;");
    expect(composer).toContain("continueInClawChatHref: string | null;");
    expect(composer).toContain('className="composer-note" title={contextLabel}');
    expect(composer).toContain('label="继续在 ClawChat 聊天"');
    expect(composer).toContain("href={continueInClawChatHref}");
    expect(composer).not.toContain("仅发送到 Connect");
    expect(cssRule(stylesheet, ".composer-context-actions")).toContain("display: flex");
    expect(cssRule(stylesheet, ".composer-note")).toContain("text-overflow: ellipsis");
    expect(cssRule(stylesheet, ".composer-note")).toContain("text-transform: uppercase");
    expect(stylesheet).not.toContain(".composer-note {\n    display: none;");
  });

  it("uses the Astryx-recommended Lucide icon instead of a hand-drawn settings glyph", async () => {
    const [icons, appShell] = await Promise.all([Bun.file(iconsUrl).text(), Bun.file(appShellUrl).text()]);

    expect(icons).not.toContain("export function SettingsIcon");
    expect(appShell).toContain('import { Icon } from "@astryxdesign/core/Icon"');
    expect(appShell).toContain('import { Settings } from "lucide-react"');
    expect(appShell).toContain("icon={<Icon icon={Settings}");
  });

  it("does not expose an opaque ClawChat user id as the message author", async () => {
    const transcriptBlock = await Bun.file(transcriptBlockUrl).text();

    expect(transcriptBlock).toContain(
      'if (block.origin === "clawchat") return block.sender?.displayName || undefined;',
    );
    expect(transcriptBlock).not.toContain("return block.sender?.id");
  });

  it("renders structured ClawChat image media instead of only its text placeholder", async () => {
    const transcriptSource = await Bun.file(transcriptBlockUrl).text();
    expect(transcriptSource).toContain('className="clawchat-message-image"');
    expect(transcriptSource).toContain("block.media?.map");
    expect(transcriptSource).toContain("visibleMessageMarkdown");
  });
});

function cssRule(stylesheet: string, selector: string): string {
  const start = stylesheet.indexOf(`${selector} {`);
  if (start < 0) return "";
  const openingBrace = stylesheet.indexOf("{", start);
  const closingBrace = stylesheet.indexOf("}", openingBrace);
  return stylesheet.slice(openingBrace + 1, closingBrace);
}

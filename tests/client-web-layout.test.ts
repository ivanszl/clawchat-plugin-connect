import { describe, expect, it } from "bun:test";

const stylesheetUrl = new URL("../web/src/styles/index.css", import.meta.url);
const sessionRouteUrl = new URL("../web/src/routes/sessions.$sessionRef.tsx", import.meta.url);
const sessionComposerUrl = new URL("../web/src/features/composer/SessionComposer.tsx", import.meta.url);
const iconsUrl = new URL("../web/src/components/icons.tsx", import.meta.url);
const appShellUrl = new URL("../web/src/features/app-shell/ConnectAppShell.tsx", import.meta.url);
const artifactWorkspaceUrl = new URL("../web/src/features/artifacts/ArtifactWorkspaceView.tsx", import.meta.url);
const transcriptBlockUrl = new URL("../web/src/features/transcript/TranscriptBlockView.tsx", import.meta.url);
const settingsPageUrl = new URL("../web/src/features/settings/SettingsPage.tsx", import.meta.url);
const sessionNavigationUrl = new URL("../web/src/features/session-catalog/SessionNavigation.tsx", import.meta.url);
const turnSubmissionHookUrl = new URL("../web/src/features/composer/useTurnSubmission.ts", import.meta.url);

describe("Connect Client session layout", () => {
  it("keeps Conversation primary and places Artifact files in a secondary dock", async () => {
    const [source, stylesheet, artifactWorkspace] = await Promise.all([
      Bun.file(sessionRouteUrl).text(),
      Bun.file(stylesheetUrl).text(),
      Bun.file(artifactWorkspaceUrl).text(),
    ]);

    expect(source).toContain('className="session-work-area"');
    expect(source).toContain('className="session-conversation"');
    expect(source).toContain("<ArtifactDock");
    expect(cssRule(stylesheet, ".session-work-area")).toContain("display: grid");
    expect(cssRule(stylesheet, ".session-conversation")).toContain("grid-template-rows");
    expect(cssRule(stylesheet, ".artifact-dock")).toContain("grid-template-rows");
    expect(artifactWorkspace).toContain('aria-label={t("@connect.artifact.openFiles")}');
    expect(artifactWorkspace).not.toContain("SESSION_ARTIFACT_ID");
    expect(artifactWorkspace).not.toContain("sessionTitle");
  });

  it("keeps localized Settings controls in Astryx layout primitives without changing protocol values", async () => {
    const source = await Bun.file(settingsPageUrl).text();
    const controls = [...source.matchAll(/<(?:Selector|TextInput)\b[\s\S]*?\/>/gu)].map(([control]) => control);

    expect(source).toContain("function SettingsField({ children, description }");
    expect(source).toContain("const t = useClientTranslator();");
    expect(source).toContain("<Grid columns={{ minWidth: 280, max: 2 }} gap={4}>");
    expect(source).toContain("<AlertDialog");
    expect(source).toContain('actionVariant="destructive"');
    expect(controls.every((control) => !control.includes("description="))).toBe(true);
    expect(source).toContain('description={t("@connect.settings.binding.model.description")}');
    expect(source).toContain('description={t("@connect.settings.binding.visibility.description")}');
    expect(source).toContain('{ value: "minimal", label: t("@connect.settings.binding.visibility.minimal") }');
    expect(source).toContain('{ value: "normal", label: t("@connect.settings.binding.visibility.normal") }');
    expect(source).toContain('{ value: "full", label: t("@connect.settings.binding.visibility.full") }');
    expect(source).not.toContain('label="附加目录"');
    expect(source).not.toMatch(/<(?:div|span)\b/u);
  });

  it("organizes Agent, Workspace, and Plugin settings with one shared Agent context", async () => {
    const source = await Bun.file(settingsPageUrl).text();

    expect(source).toContain('import { Tab, TabList } from "@astryxdesign/core/TabList"');
    expect(source).toContain('const [activeTab, setActiveTab] = useState<SettingsTab>("agent")');
    expect(source).toContain("const [selectedBindingId, setSelectedBindingId]");
    expect(source).toContain('<Tab value="agent"');
    expect(source).toContain('<Tab value="workspace"');
    expect(source).toContain('<Tab value="plugins"');
    expect(source).toContain("<BindingContextSelector");
    expect(source).toContain("<WorkspaceSettings key={selectedBinding.bindingId} binding={selectedBinding} />");
    expect(source).not.toContain('t("@connect.settings.continuity.description")');
  });

  it("keeps model settings out of the Session header and inside the composer", async () => {
    const source = await Bun.file(sessionRouteUrl).text();
    const header = source.slice(source.indexOf('<header className="session-header">'), source.indexOf("</header>"));

    expect(header).not.toContain("<SessionModelControls");
    expect(source).toContain("modelControl={<SessionModelControls view={view} />}");
    expect(source).toContain('label={t("@connect.composer.model.popoverLabel")}');
    expect(source).toContain('placement="above"');
  });

  it("keeps one populated heading row across mobile Conversation and Artifact surfaces", async () => {
    const [source, stylesheet, artifactWorkspace] = await Promise.all([
      Bun.file(sessionRouteUrl).text(),
      Bun.file(stylesheetUrl).text(),
      Bun.file(artifactWorkspaceUrl).text(),
    ]);
    const mobileStyles = stylesheet.slice(stylesheet.indexOf("@media (max-width: 720px)"));

    expect(source).toContain("data-artifact-open={artifactWorkspace.activeTab ? true : undefined}");
    expect(cssRule(mobileStyles, ".session-heading")).not.toContain("display: none");
    expect(cssRule(mobileStyles, '.session-header[data-artifact-open="true"] .session-heading')).toContain(
      "display: none",
    );
    expect(artifactWorkspace).toContain("<h1 title={workspace.activeTab.title}>{workspace.activeTab.title}</h1>");
    expect(artifactWorkspace).toContain('className="artifact-mobile-controls"');
  });

  it("optimistically enters the message in Chat without exposing transfer progress", async () => {
    const composer = await Bun.file(sessionComposerUrl).text();

    expect(composer).toContain("submissionId: requestId()");
    expect(composer).toContain("composerDisabled || send.isPending || !hasSubmissionDraft");
    expect(composer).not.toContain("<ProgressBar");
    expect(composer).not.toContain("send.progress");
    expect(composer).not.toContain("cancelSubmission");
  });

  it("uses Astryx Chat primitives for slash selection, tokenized messages, attachments, and failed-message retry", async () => {
    const [composer, turnSubmission, transcript, stylesheet] = await Promise.all([
      Bun.file(sessionComposerUrl).text(),
      Bun.file(turnSubmissionHookUrl).text(),
      Bun.file(transcriptBlockUrl).text(),
      Bun.file(stylesheetUrl).text(),
    ]);

    expect(composer).toContain("type ChatComposerTrigger");
    expect(composer).toContain("triggers={[slashTrigger]}");
    expect(composer).toContain("<TypeaheadItem");
    expect(composer).toContain("<Token");
    expect(composer).not.toContain("<ProgressBar");
    expect(composer).not.toContain('className="slash-suggestions"');
    expect(composer).not.toContain("onKeyDownCapture");
    expect(stylesheet).not.toContain(".slash-suggestions");
    expect(stylesheet).not.toContain(".composer-attachment");
    expect(stylesheet).not.toContain(".composer-submission-progress");
    expect(transcript).toContain("<ChatTokenizedText");
    expect(transcript).toContain("<IconButton");
    expect(turnSubmission).toContain("markUnpersistedMessageFailed");
    expect(turnSubmission).toContain('allowedActions: ["retry"]');
    expect(turnSubmission).toContain("localTurnSubmissions");
    expect(transcript).toContain("retryVisibleTurnSubmission");
    expect(composer).not.toContain("setValue(prompt)");
    expect(composer).not.toContain("send.error");
  });

  it("derives the New Session Agent from context instead of rendering another selector", async () => {
    const source = await Bun.file(sessionNavigationUrl).text();
    const dialog = source.slice(
      source.indexOf("export function NewSessionDialog"),
      source.indexOf("function navigationItems"),
    );

    expect(dialog).toContain("preferredBindingId");
    expect(dialog).not.toContain('label={t("@connect.newSession.binding.label")}');
    expect(dialog).not.toContain("changeBinding");
  });

  it("keeps a pointer-accessible enqueue action while the Agent is working", async () => {
    const composer = await Bun.file(sessionComposerUrl).text();

    expect(composer).toContain("const hasSubmissionDraft = Boolean(value.trim() || attachments.length > 0);");
    expect(composer).toContain("isAgentWorking && !hasSubmissionDraft");
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
    expect(composer).toContain('label={t("@connect.composer.continueInClawChat")}');
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

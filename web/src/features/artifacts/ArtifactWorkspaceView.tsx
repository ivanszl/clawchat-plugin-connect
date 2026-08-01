import { Banner } from "@astryxdesign/core/Banner";
import { CodeBlock } from "@astryxdesign/core/CodeBlock";
import { Dialog } from "@astryxdesign/core/Dialog";
import { Lightbox } from "@astryxdesign/core/Lightbox";
import { Markdown } from "@astryxdesign/core/Markdown";
import { Spinner } from "@astryxdesign/core/Spinner";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  classifyWorkspaceArtifact,
  normalizeWorkspaceArtifactHref,
  workspaceArtifactUrl,
} from "../../../../src/workspace-artifact";
import {
  type ArtifactTab,
  type ArtifactWorkspaceState,
  activateArtifact,
  closeArtifact,
  createArtifactWorkspaceState,
  openArtifact,
  parseDelimitedText,
  SESSION_ARTIFACT_ID,
} from "./artifact-workspace";

export interface ArtifactWorkspaceController {
  state: ArtifactWorkspaceState;
  activeTab: ArtifactTab | null;
  open(path: string): void;
  close(id: string): void;
  activate(id: string): void;
}

export function useArtifactWorkspace(sessionRef: string): ArtifactWorkspaceController {
  const storageKey = artifactStorageKey(sessionRef);
  const [state, setState] = useState<ArtifactWorkspaceState>(() => restoreArtifactState(storageKey));
  useEffect(() => setState(restoreArtifactState(storageKey)), [storageKey]);
  useEffect(() => {
    try {
      window.sessionStorage.setItem(storageKey, JSON.stringify(state));
    } catch {
      // Session storage is optional in privacy-restricted WebViews.
    }
  }, [state, storageKey]);
  const open = useCallback(
    (path: string) => setState((current) => openArtifact(current, sessionRef, path)),
    [sessionRef],
  );
  const close = useCallback((id: string) => setState((current) => closeArtifact(current, id)), []);
  const activate = useCallback((id: string) => setState((current) => activateArtifact(current, id)), []);
  return {
    state,
    activeTab: state.tabs.find((tab) => tab.id === state.activeId) ?? null,
    open,
    close,
    activate,
  };
}

export function ArtifactNavigation({
  sessionTitle,
  workspace,
}: {
  sessionTitle: string;
  workspace: ArtifactWorkspaceController;
}) {
  const [mobileOpen, setMobileOpen] = useState(false);
  const activeTitle = workspace.activeTab?.title ?? sessionTitle;
  const select = (id: string) => {
    workspace.activate(id);
    setMobileOpen(false);
  };
  return (
    <>
      <div className="artifact-desktop-tabs" role="tablist" aria-label="Session 和已打开文件">
        <button
          className="artifact-tab"
          type="button"
          role="tab"
          aria-selected={workspace.state.activeId === SESSION_ARTIFACT_ID}
          onClick={() => workspace.activate(SESSION_ARTIFACT_ID)}
        >
          {sessionTitle}
        </button>
        {workspace.state.tabs.map((tab) => (
          <div className="artifact-tab-group" key={tab.id}>
            <button
              className="artifact-tab"
              type="button"
              role="tab"
              aria-selected={workspace.state.activeId === tab.id}
              title={tab.path}
              onClick={() => workspace.activate(tab.id)}
            >
              {tab.title}
            </button>
            <button
              className="artifact-tab-close"
              type="button"
              aria-label={`关闭 ${tab.title}`}
              onClick={() => workspace.close(tab.id)}
            >
              ×
            </button>
          </div>
        ))}
      </div>
      <div className="artifact-mobile-navigation">
        {workspace.activeTab ? (
          <button className="artifact-mobile-back" type="button" onClick={() => select(SESSION_ARTIFACT_ID)}>
            ← 对话
          </button>
        ) : null}
        <h1 title={activeTitle}>{activeTitle}</h1>
        <button className="artifact-mobile-open" type="button" onClick={() => setMobileOpen(true)}>
          已打开 {workspace.state.tabs.length > 0 ? `(${workspace.state.tabs.length})` : ""}
        </button>
      </div>
      <Dialog
        className="artifact-mobile-sheet"
        isOpen={mobileOpen}
        onOpenChange={setMobileOpen}
        width="calc(100vw - 16px)"
        maxHeight="70dvh"
        position={{ left: 8, right: 8, bottom: 8 }}
        padding={0}
        style={{ maxWidth: "calc(100vw - 16px)" }}
      >
        <div className="artifact-mobile-sheet-content">
          <header>
            <strong>已打开项目</strong>
            <button type="button" onClick={() => setMobileOpen(false)} aria-label="关闭已打开项目">
              ×
            </button>
          </header>
          <ArtifactSheetRow
            title={sessionTitle}
            isActive={workspace.state.activeId === SESSION_ARTIFACT_ID}
            onSelect={() => select(SESSION_ARTIFACT_ID)}
          />
          {workspace.state.tabs.map((tab) => (
            <ArtifactSheetRow
              key={tab.id}
              title={tab.title}
              subtitle={tab.path}
              isActive={workspace.state.activeId === tab.id}
              onSelect={() => select(tab.id)}
              onClose={() => workspace.close(tab.id)}
            />
          ))}
        </div>
      </Dialog>
    </>
  );
}

function ArtifactSheetRow({
  title,
  subtitle,
  isActive,
  onSelect,
  onClose,
}: {
  title: string;
  subtitle?: string;
  isActive: boolean;
  onSelect(): void;
  onClose?: () => void;
}) {
  return (
    <div className="artifact-sheet-row" data-active={isActive || undefined}>
      <button type="button" onClick={onSelect}>
        <strong>{title}</strong>
        {subtitle ? <small>{subtitle}</small> : null}
      </button>
      {onClose ? (
        <button type="button" aria-label={`关闭 ${title}`} onClick={onClose}>
          ×
        </button>
      ) : null}
    </div>
  );
}

export function ArtifactViewer({
  sessionRef,
  tab,
  openArtifact: openNestedArtifact,
}: {
  sessionRef: string;
  tab: ArtifactTab;
  openArtifact(path: string): void;
}) {
  const isText = ["markdown", "text", "code", "diff", "table", "html"].includes(tab.kind);
  const text = useArtifactText(tab.contentUrl, isText);
  let content: ReactNode;
  if (isText && text.state === "loading") content = <Spinner label={`正在打开 ${tab.title}`} />;
  else if (isText && text.state === "error") {
    content = <Banner status="error" title="无法打开文件" description={text.message} />;
  } else if (tab.kind === "markdown") {
    content = (
      <ArtifactMarkdown
        markdown={text.content}
        sessionRef={sessionRef}
        basePath={tab.path}
        openArtifact={openNestedArtifact}
      />
    );
  } else if (tab.kind === "code" || tab.kind === "diff" || tab.kind === "text") {
    content = (
      <CodeBlock
        code={text.content}
        language={tab.language}
        title={tab.title}
        hasCopyButton
        hasLineNumbers={tab.kind !== "text"}
        isWrapped={tab.kind === "text"}
        width="100%"
      />
    );
  } else if (tab.kind === "table") {
    content = <ArtifactTable source={text.content} delimiter={tab.language === "tsv" ? "\t" : ","} />;
  } else if (tab.kind === "html") {
    content = <ArtifactHtml source={text.content} title={tab.title} />;
  } else if (tab.kind === "image" || tab.kind === "svg") {
    content = <ArtifactImage tab={tab} />;
  } else if (tab.kind === "pdf") {
    content = <iframe className="artifact-pdf" src={tab.contentUrl} title={tab.title} />;
  } else content = <Banner status="warning" title="不支持的文件" description={tab.path} />;
  return (
    <section className="artifact-viewer" aria-label={tab.title}>
      <header className="artifact-viewer-header">
        <div>
          <strong>{tab.title}</strong>
          <small title={tab.path}>{tab.path}</small>
        </div>
        <a href={tab.contentUrl} download={tab.title}>
          下载
        </a>
      </header>
      <div className={`artifact-content artifact-content-${tab.kind}`}>{content}</div>
    </section>
  );
}

function ArtifactMarkdown({
  markdown,
  sessionRef,
  basePath,
  openArtifact,
}: {
  markdown: string;
  sessionRef: string;
  basePath: string;
  openArtifact(path: string): void;
}) {
  return (
    <Markdown
      className="artifact-markdown"
      headingLevelStart={1}
      autolink="gfm"
      contentWidth="82ch"
      components={{
        code: ({ code, language }) => (
          <CodeBlock code={code} language={language} hasCopyButton isWrapped width="100%" />
        ),
        link: ({ href, children }) => (
          <ArtifactMarkdownLink href={href} basePath={basePath} sessionRef={sessionRef} openArtifact={openArtifact}>
            {children}
          </ArtifactMarkdownLink>
        ),
        image: ({ src, alt }) => {
          const path = normalizeWorkspaceArtifactHref(src, basePath);
          const type = path ? classifyWorkspaceArtifact(path) : null;
          if (!path || (type?.kind !== "image" && type?.kind !== "svg")) {
            return <span className="blocked-image">[图片已阻止：{alt || "无描述"}]</span>;
          }
          return <img className="artifact-markdown-image" src={workspaceArtifactUrl(sessionRef, path)} alt={alt} />;
        },
      }}
    >
      {markdown}
    </Markdown>
  );
}

function ArtifactMarkdownLink({
  href,
  basePath,
  sessionRef,
  openArtifact,
  children,
}: {
  href: string;
  basePath: string;
  sessionRef: string;
  openArtifact(path: string): void;
  children: ReactNode;
}) {
  const path = normalizeWorkspaceArtifactHref(href, basePath);
  if (path) {
    return (
      <a
        href={workspaceArtifactUrl(sessionRef, path)}
        onClick={(event) => {
          event.preventDefault();
          openArtifact(path);
        }}
      >
        {children}
      </a>
    );
  }
  return isSafeExternalLink(href) ? (
    <a href={href} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ) : (
    <span>{children}</span>
  );
}

function ArtifactImage({ tab }: { tab: ArtifactTab }) {
  const [lightboxOpen, setLightboxOpen] = useState(false);
  return (
    <>
      <button className="artifact-image-button" type="button" onClick={() => setLightboxOpen(true)}>
        <img src={tab.contentUrl} alt={tab.title} />
      </button>
      <Lightbox
        isOpen={lightboxOpen}
        onOpenChange={setLightboxOpen}
        media={{ src: tab.contentUrl, alt: tab.title, caption: tab.path }}
        hasZoom
      />
    </>
  );
}

function ArtifactTable({ source, delimiter }: { source: string; delimiter: "," | "\t" }) {
  const parsed = useMemo(() => parseDelimitedText(source, delimiter), [delimiter, source]);
  const [header = [], ...rows] = parsed.rows;
  if (header.length === 0) return <Banner status="info" title="表格为空" />;
  const headerCells = header.map((cell, columnIndex) => ({
    id: `column-${columnIndex}-${cell}`,
    label: cell || `列 ${columnIndex + 1}`,
    columnIndex,
  }));
  const tableRows = rows.map((cells, rowIndex) => ({ id: `row-${rowIndex}-${cells.join("\u241f")}`, cells }));
  return (
    <div className="artifact-table-frame">
      {parsed.truncated ? <p className="artifact-table-notice">预览已限制为 2,000 行、100 列。</p> : null}
      <table>
        <thead>
          <tr>
            {headerCells.map((cell) => (
              <th key={cell.id}>{cell.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {tableRows.map((row) => (
            <tr key={row.id}>
              {headerCells.map((column) => (
                <td key={column.id}>{row.cells[column.columnIndex] ?? ""}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ArtifactHtml({ source, title }: { source: string; title: string }) {
  const [preview, setPreview] = useState(false);
  return (
    <div className="artifact-html">
      <fieldset className="artifact-html-mode" aria-label="HTML 查看方式">
        <button type="button" aria-pressed={!preview} onClick={() => setPreview(false)}>
          源码
        </button>
        <button type="button" aria-pressed={preview} onClick={() => setPreview(true)}>
          安全预览
        </button>
      </fieldset>
      {preview ? (
        <iframe
          className="artifact-html-preview"
          sandbox=""
          srcDoc={sandboxedHtml(source)}
          title={`${title} 安全预览`}
        />
      ) : (
        <CodeBlock code={source} language="html" title={title} hasCopyButton hasLineNumbers width="100%" />
      )}
    </div>
  );
}

function useArtifactText(
  url: string,
  enabled: boolean,
): { state: "loading" | "ready" | "error"; content: string; message?: string } {
  const [result, setResult] = useState<{ state: "loading" | "ready" | "error"; content: string; message?: string }>(
    () => ({
      state: enabled ? "loading" : "ready",
      content: "",
    }),
  );
  useEffect(() => {
    if (!enabled) {
      setResult({ state: "ready", content: "" });
      return;
    }
    const controller = new AbortController();
    setResult({ state: "loading", content: "" });
    void fetch(url, { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return await response.text();
      })
      .then((content) => setResult({ state: "ready", content }))
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setResult({ state: "error", content: "", message: error instanceof Error ? error.message : String(error) });
      });
    return () => controller.abort();
  }, [enabled, url]);
  return result;
}

function restoreArtifactState(storageKey: string): ArtifactWorkspaceState {
  if (typeof window === "undefined") return createArtifactWorkspaceState();
  try {
    return createArtifactWorkspaceState(JSON.parse(window.sessionStorage.getItem(storageKey) ?? "null"));
  } catch {
    return createArtifactWorkspaceState();
  }
}

function artifactStorageKey(sessionRef: string): string {
  return `clawchat-connect:artifact-workspace:${sessionRef}`;
}

function sandboxedHtml(source: string): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:; media-src data:">${source}`;
}

function isSafeExternalLink(href: string): boolean {
  try {
    const url = new URL(href);
    return url.protocol === "https:" || url.protocol === "http:" || url.protocol === "mailto:";
  } catch {
    return false;
  }
}

export type WorkspaceArtifactKind = "markdown" | "text" | "code" | "diff" | "image" | "pdf" | "table" | "svg" | "html";

export interface WorkspaceArtifactType {
  kind: WorkspaceArtifactKind;
  mime: string;
  language?: string;
  maxBytes: number;
  isText: boolean;
}

const MAX_TEXT_BYTES = 2 * 1_024 * 1_024;
const MAX_IMAGE_BYTES = 20 * 1_024 * 1_024;
const MAX_PDF_BYTES = 50 * 1_024 * 1_024;

const MARKDOWN_EXTENSIONS = new Set(["md", "markdown"]);
const TEXT_EXTENSIONS = new Set(["txt", "log", "out"]);
const DIFF_EXTENSIONS = new Set(["diff", "patch"]);
const TABLE_EXTENSIONS = new Set(["csv", "tsv"]);
const HTML_EXTENSIONS = new Set(["html", "htm"]);
const IMAGE_MIME = new Map([
  ["png", "image/png"],
  ["jpg", "image/jpeg"],
  ["jpeg", "image/jpeg"],
  ["webp", "image/webp"],
  ["gif", "image/gif"],
  ["avif", "image/avif"],
]);
const CODE_LANGUAGES = new Map([
  ["ts", "typescript"],
  ["tsx", "tsx"],
  ["js", "javascript"],
  ["jsx", "jsx"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["json", "json"],
  ["jsonc", "jsonc"],
  ["yaml", "yaml"],
  ["yml", "yaml"],
  ["toml", "toml"],
  ["xml", "xml"],
  ["css", "css"],
  ["scss", "scss"],
  ["less", "less"],
  ["py", "python"],
  ["rb", "ruby"],
  ["go", "go"],
  ["rs", "rust"],
  ["java", "java"],
  ["kt", "kotlin"],
  ["kts", "kotlin"],
  ["swift", "swift"],
  ["c", "c"],
  ["h", "c"],
  ["cpp", "cpp"],
  ["cc", "cpp"],
  ["hpp", "cpp"],
  ["cs", "csharp"],
  ["php", "php"],
  ["sh", "shell"],
  ["bash", "shell"],
  ["zsh", "shell"],
  ["fish", "shell"],
  ["sql", "sql"],
  ["graphql", "graphql"],
  ["gql", "graphql"],
  ["vue", "vue"],
  ["svelte", "svelte"],
  ["astro", "astro"],
]);

const EXTENSIONLESS_CODE_LANGUAGES = new Map([
  ["dockerfile", "dockerfile"],
  ["makefile", "makefile"],
  ["gemfile", "ruby"],
]);

export function classifyWorkspaceArtifact(path: string): WorkspaceArtifactType | null {
  const filename = path.split(/[\\/]/u).at(-1)?.trim() ?? "";
  if (!filename || filename.startsWith(".")) return null;
  const lowercaseFilename = filename.toLowerCase();
  const extension = lowercaseFilename.includes(".") ? (lowercaseFilename.split(".").at(-1) ?? "") : "";
  if (MARKDOWN_EXTENSIONS.has(extension)) {
    return textArtifact("markdown", "markdown");
  }
  if (TEXT_EXTENSIONS.has(extension)) return textArtifact("text");
  if (DIFF_EXTENSIONS.has(extension)) return textArtifact("diff", "diff");
  if (TABLE_EXTENSIONS.has(extension)) {
    return {
      kind: "table",
      mime: extension === "tsv" ? "text/tab-separated-values; charset=utf-8" : "text/csv; charset=utf-8",
      language: extension,
      maxBytes: MAX_TEXT_BYTES,
      isText: true,
    };
  }
  if (HTML_EXTENSIONS.has(extension)) return textArtifact("html", "html");
  if (extension === "svg") {
    return { kind: "svg", mime: "image/svg+xml", maxBytes: MAX_IMAGE_BYTES, isText: false };
  }
  if (extension === "pdf") {
    return { kind: "pdf", mime: "application/pdf", maxBytes: MAX_PDF_BYTES, isText: false };
  }
  const imageMime = IMAGE_MIME.get(extension);
  if (imageMime) return { kind: "image", mime: imageMime, maxBytes: MAX_IMAGE_BYTES, isText: false };
  const language = CODE_LANGUAGES.get(extension) ?? EXTENSIONLESS_CODE_LANGUAGES.get(lowercaseFilename);
  return language ? textArtifact("code", language) : null;
}

export function normalizeWorkspaceArtifactHref(href: string, basePath?: string): string | null {
  let candidate = href.trim();
  if (candidate.startsWith("<") && candidate.endsWith(">")) candidate = candidate.slice(1, -1).trim();
  if (/^[a-z][a-z\d+.-]*:/iu.test(candidate)) return null;
  if (!candidate.startsWith("/")) {
    if (!basePath || candidate.startsWith("#") || candidate.startsWith("?")) return null;
    const baseDirectory = basePath.slice(0, Math.max(0, basePath.lastIndexOf("/") + 1));
    candidate = normalizeAbsolutePath(`${baseDirectory}${candidate}`);
  }
  const withoutLocation = candidate.replace(/:\d+(?::\d+)?$/u, "");
  if (classifyWorkspaceArtifact(candidate)) return candidate;
  return classifyWorkspaceArtifact(withoutLocation) ? withoutLocation : null;
}

export function workspaceArtifactUrl(sessionRef: string, path: string): string {
  return `/client/v1/sessions/${encodeURIComponent(sessionRef)}/files?path=${encodeURIComponent(path)}`;
}

function textArtifact(
  kind: Extract<WorkspaceArtifactKind, "markdown" | "text" | "code" | "diff" | "html">,
  language?: string,
): WorkspaceArtifactType {
  return { kind, mime: "text/plain; charset=utf-8", language, maxBytes: MAX_TEXT_BYTES, isText: true };
}

function normalizeAbsolutePath(path: string): string {
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") segments.pop();
    else segments.push(segment);
  }
  return `/${segments.join("/")}`;
}

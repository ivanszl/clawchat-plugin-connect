import {
  classifyWorkspaceArtifact,
  type WorkspaceArtifactKind,
  workspaceArtifactUrl,
} from "../../../../src/workspaces/workspace-artifact";

export const MAX_OPEN_ARTIFACTS = 12;

export interface ArtifactTab {
  id: string;
  path: string;
  title: string;
  kind: WorkspaceArtifactKind;
  mime: string;
  language?: string;
  contentUrl: string;
}

export interface ArtifactWorkspaceState {
  activeId: string | null;
  tabs: ArtifactTab[];
}

export function createArtifactWorkspaceState(value?: Partial<ArtifactWorkspaceState> | null): ArtifactWorkspaceState {
  const tabs = Array.isArray(value?.tabs) ? value.tabs.filter(isArtifactTab).slice(-MAX_OPEN_ARTIFACTS) : [];
  const requestedActiveId = value?.activeId;
  const activeId = requestedActiveId && tabs.some((tab) => tab.id === requestedActiveId) ? requestedActiveId : null;
  return { activeId, tabs };
}

export function openArtifact(state: ArtifactWorkspaceState, sessionRef: string, path: string): ArtifactWorkspaceState {
  const type = classifyWorkspaceArtifact(path);
  if (!type) return state;
  const existing = state.tabs.find((tab) => tab.path === path);
  if (existing) return { ...state, activeId: existing.id };
  const tab: ArtifactTab = {
    id: path,
    path,
    title: path.split("/").at(-1) || path,
    kind: type.kind,
    mime: type.mime,
    ...(type.language ? { language: type.language } : {}),
    contentUrl: workspaceArtifactUrl(sessionRef, path),
  };
  return { activeId: tab.id, tabs: [...state.tabs, tab].slice(-MAX_OPEN_ARTIFACTS) };
}

export function activateArtifact(state: ArtifactWorkspaceState, id: string): ArtifactWorkspaceState {
  if (!state.tabs.some((tab) => tab.id === id)) return state;
  return state.activeId === id ? state : { ...state, activeId: id };
}

export function showConversation(state: ArtifactWorkspaceState): ArtifactWorkspaceState {
  return state.activeId === null ? state : { ...state, activeId: null };
}

export function closeArtifact(state: ArtifactWorkspaceState, id: string): ArtifactWorkspaceState {
  const index = state.tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return state;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  if (state.activeId !== id) return { ...state, tabs };
  return { activeId: tabs[Math.min(index, tabs.length - 1)]?.id ?? null, tabs };
}

export interface DelimitedTextResult {
  rows: string[][];
  truncated: boolean;
}

export function parseDelimitedText(
  source: string,
  delimiter: "," | "\t",
  limits: { maxRows: number; maxColumns: number } = { maxRows: 2_000, maxColumns: 100 },
): DelimitedTextResult {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let truncated = false;
  const pushField = () => {
    if (row.length < limits.maxColumns) row.push(field);
    else truncated = true;
    field = "";
  };
  const pushRow = () => {
    pushField();
    if (rows.length < limits.maxRows) rows.push(row);
    else truncated = true;
    row = [];
  };
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index] ?? "";
    if (character === '"') {
      if (quoted && source[index + 1] === '"') {
        field += '"';
        index += 1;
      } else quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      pushField();
      continue;
    }
    if (!quoted && (character === "\n" || character === "\r")) {
      if (character === "\r" && source[index + 1] === "\n") index += 1;
      pushRow();
      continue;
    }
    field += character;
  }
  if (field || row.length > 0) pushRow();
  return { rows, truncated };
}

function isArtifactTab(value: unknown): value is ArtifactTab {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<ArtifactTab>;
  return (
    typeof candidate.id === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.title === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.mime === "string" &&
    typeof candidate.contentUrl === "string" &&
    candidate.id === candidate.path &&
    Boolean(classifyWorkspaceArtifact(candidate.path))
  );
}

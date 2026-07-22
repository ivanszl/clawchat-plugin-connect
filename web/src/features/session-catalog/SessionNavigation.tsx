import { Button } from "@astryxdesign/core/Button";
import { SideNav, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TreeList, type TreeListItemData } from "@astryxdesign/core/TreeList";
import { useQuery } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { SessionCatalogBindingView, SessionCatalogEntryView } from "../../../../src/client-contract";
import { catalogQueryOptions } from "../../client-interface/query-options";
import { FolderIcon, RefreshIcon, ThreadIcon } from "../../components/icons";

export function SessionNavigation() {
  const catalog = useQuery(catalogQueryOptions);
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  const selectedRef = pathname.match(/^\/sessions\/([^/]+)$/u)?.[1]?.toUpperCase() ?? null;
  const [search, setSearch] = useState("");

  const sections = useMemo(
    () =>
      (catalog.data?.bindings ?? []).map((binding) => ({
        binding,
        items: navigationItems(binding, search, selectedRef, (sessionRef) => {
          void navigate({ to: "/sessions/$sessionRef", params: { sessionRef } });
        }),
      })),
    [catalog.data, navigate, search, selectedRef],
  );

  return (
    <SideNav
      className="session-nav"
      collapsible={{ buttonLabel: "折叠 Session 导航" }}
      resizable={{ defaultWidth: 304, minWidth: 248, maxWidth: 440, autoSaveId: "connect-client-session-nav" }}
      topContent={
        <div className="session-nav-tools">
          <TextInput
            label="搜索 Session"
            isLabelHidden
            value={search}
            onChange={setSearch}
            placeholder="搜索 session 或 project"
            hasClear
            width="100%"
          />
          <Button
            label="刷新全部 Session"
            isIconOnly
            icon={<RefreshIcon />}
            size="sm"
            variant="ghost"
            isLoading={catalog.isFetching}
            onClick={() => void catalog.refetch()}
          />
        </div>
      }
    >
      {catalog.isPending ? (
        <div className="nav-loading">
          <Spinner label="正在加载 Session" />
        </div>
      ) : catalog.isError ? (
        <p className="nav-error">无法加载 Session。Connect Service 可能尚未就绪。</p>
      ) : (
        sections.map(({ binding, items }) => (
          <SideNavSection
            key={binding.bindingId}
            title={binding.displayName}
            endContent={
              <StatusDot
                variant={
                  binding.status === "connected" ? "success" : binding.status === "disconnected" ? "error" : "neutral"
                }
                label={
                  binding.status === "connected" ? "已连接" : binding.status === "disconnected" ? "已断开" : "状态未知"
                }
                isPulsing={binding.status === "connected"}
              />
            }
          >
            {items.length > 0 ? (
              <TreeList items={items} density="compact" />
            ) : (
              <p className="nav-empty">没有匹配的 Session</p>
            )}
          </SideNavSection>
        ))
      )}
    </SideNav>
  );
}

function navigationItems(
  binding: SessionCatalogBindingView,
  search: string,
  selectedRef: string | null,
  open: (sessionRef: string) => void,
): TreeListItemData[] {
  const needle = search.trim().toLocaleLowerCase();
  const visible = binding.entries.filter((entry) => {
    if (!needle) return true;
    return [entry.name, entry.workspaceName, entry.projectName, entry.sessionRef].some((value) =>
      value?.toLocaleLowerCase().includes(needle),
    );
  });
  const active = visible.filter((entry) => !entry.isArchived);
  const archived = visible.filter((entry) => entry.isArchived);
  const items = groupedItems(active, "active", selectedRef, needle, open);
  if (archived.length > 0) {
    items.push({
      id: `archived:${binding.bindingId}`,
      label: "已归档",
      startContent: <FolderIcon />,
      isExpanded: archived.some((entry) => entry.sessionRef === selectedRef) || Boolean(needle),
      children: groupedItems(archived, "archived", selectedRef, needle, open),
    });
  }
  return items;
}

function groupedItems(
  entries: SessionCatalogEntryView[],
  prefix: string,
  selectedRef: string | null,
  search: string,
  open: (sessionRef: string) => void,
): TreeListItemData[] {
  const workspaces = new Map<string, SessionCatalogEntryView[]>();
  const nonProject: SessionCatalogEntryView[] = [];
  for (const entry of entries) {
    if (!entry.workspaceId) {
      nonProject.push(entry);
      continue;
    }
    const workspaceEntries = workspaces.get(entry.workspaceId) ?? [];
    workspaceEntries.push(entry);
    workspaces.set(entry.workspaceId, workspaceEntries);
  }
  const workspaceItems: TreeListItemData[] = [...workspaces.entries()].map(([workspaceId, entries]) => ({
    id: `${prefix}:workspace:${workspaceId}`,
    label: entries[0]?.workspaceName || "Unnamed workspace",
    startContent: <FolderIcon />,
    isExpanded: entries.some((entry) => entry.sessionRef === selectedRef) || Boolean(search),
    children: entries.map((entry) => sessionItem(entry, selectedRef, open)),
  }));
  return [...workspaceItems, ...nonProject.map((entry) => sessionItem(entry, selectedRef, open))];
}

function sessionItem(
  entry: SessionCatalogEntryView,
  selectedRef: string | null,
  open: (sessionRef: string) => void,
): TreeListItemData {
  return {
    id: entry.sessionRef,
    label: entry.name,
    description: `${entry.sessionRef} · ${entry.isArchived ? "已归档" : statusLabel(entry.status)}`,
    startContent: <ThreadIcon />,
    endContent: entry.status === "running" ? <StatusDot variant="accent" label="正在运行" isPulsing /> : undefined,
    isSelected: entry.sessionRef === selectedRef,
    href: `/sessions/${entry.sessionRef}`,
    onClick: (event) => {
      event.preventDefault();
      open(entry.sessionRef);
    },
  };
}

function statusLabel(status: SessionCatalogEntryView["status"]): string {
  return { idle: "空闲", running: "运行中", queued: "排队中", offline: "离线", error: "错误" }[status];
}

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { LinkProvider } from "@astryxdesign/core/Link";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TreeList, type TreeListItemData } from "@astryxdesign/core/TreeList";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type {
  BindingPreferenceView,
  ProjectDirectoryRequest,
  ProjectView,
  SessionCatalogBindingView,
  SessionCatalogEntryView,
} from "../../../../src/client-contract";
import { catalogQueryOptions, createSession } from "../../client-interface/query-options";
import { AddIcon, FolderIcon, ThreadIcon } from "../../components/icons";
import { HostDirectoryPicker, projectDirectoryLabel } from "../projects/HostDirectoryPicker";

export function SessionNavigation({ onNewSession }: { onNewSession: () => void }) {
  const catalog = useQuery(catalogQueryOptions);
  const navigate = useNavigate();
  const [navigationCollapsed, setNavigationCollapsed] = useState(false);
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
    <LinkProvider component={Link}>
      <SideNav
        className="session-nav"
        data-mode={navigationCollapsed ? "collapsed" : "expanded"}
        collapsible={{
          isCollapsed: navigationCollapsed,
          onCollapsedChange: setNavigationCollapsed,
          buttonLabel: "折叠 Session 导航",
        }}
        resizable={{ defaultWidth: 304, minWidth: 248, maxWidth: 440, autoSaveId: "connect-client-session-nav" }}
        topContent={
          <HStack gap={2} padding={2} align="end" justify={navigationCollapsed ? "center" : "start"}>
            {navigationCollapsed ? null : (
              <StackItem size="fill">
                <TextInput
                  label="搜索 Session"
                  isLabelHidden
                  value={search}
                  onChange={setSearch}
                  placeholder="搜索 session 或 project"
                  hasClear
                  width="100%"
                />
              </StackItem>
            )}
            <Button
              label="新建 Session"
              isIconOnly
              icon={<AddIcon />}
              size="sm"
              variant="primary"
              onClick={onNewSession}
            />
          </HStack>
        }
      >
        {navigationCollapsed ? null : catalog.isPending ? (
          <VStack padding={4} align="center">
            <Spinner label="正在加载 Session" />
          </VStack>
        ) : catalog.isError ? (
          <Text color="secondary" display="block" justify="center">
            无法加载 Session。Connect Service 可能尚未就绪。
          </Text>
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
                    binding.status === "connected"
                      ? "已连接"
                      : binding.status === "disconnected"
                        ? "已断开"
                        : "状态未知"
                  }
                  isPulsing={binding.status === "connected"}
                />
              }
            >
              {items.length > 0 ? (
                <TreeList items={items} density="compact" />
              ) : (
                <Text color="secondary" display="block" justify="center">
                  没有匹配的 Session
                </Text>
              )}
            </SideNavSection>
          ))
        )}
      </SideNav>
    </LinkProvider>
  );
}

export function NewSessionDialog({
  isOpen,
  bindings,
  catalogBindings,
  projects,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  bindings: BindingPreferenceView[];
  catalogBindings: SessionCatalogBindingView[];
  projects: ProjectView[];
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const [bindingId, setBindingId] = useState(bindings[0]?.bindingId ?? "");
  const [workspaceSelection, setWorkspaceSelection] = useState("none");
  const [pendingProject, setPendingProject] = useState<ProjectDirectoryRequest | null>(null);
  const [isPickingProject, setIsPickingProject] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("default");
  const [model, setModel] = useState("default");
  const [reasoningEffort, setReasoningEffort] = useState("default");
  useEffect(() => {
    if (!bindings.some((binding) => binding.bindingId === bindingId)) setBindingId(bindings[0]?.bindingId ?? "");
  }, [bindingId, bindings]);
  useEffect(() => {
    if (isOpen) return;
    setIsPickingProject(false);
    setPendingProject(null);
    setWorkspaceSelection("none");
  }, [isOpen]);
  const binding = bindings.find((candidate) => candidate.bindingId === bindingId) ?? bindings[0];
  const workspaceOptions = newSessionWorkspaceOptions(catalogBindings, bindingId, projects);
  const selectedModel = binding?.modelOptions.find((candidate) => candidate.id === model);
  const create = useMutation({
    mutationFn: async () =>
      await createSession({
        bindingId,
        workspace: pendingProject
          ? { kind: "new-project", directory: pendingProject }
          : workspaceSelection === "none"
            ? { kind: "none" }
            : { kind: "existing", workspaceId: workspaceSelection },
        name: name.trim() || null,
        mode: mode === "default" ? null : mode,
        model: model === "default" ? null : model,
        reasoningEffort: model === "default" ? null : reasoningEffort,
      }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
      onCreated(session.sessionRef);
    },
  });
  const changeBinding = (value: string) => {
    setBindingId(value);
    setMode("default");
    setModel("default");
    setReasoningEffort("default");
    setWorkspaceSelection("none");
    setPendingProject(null);
    setIsPickingProject(false);
  };
  return (
    <Dialog
      className="new-session-dialog"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={520}
      maxHeight="calc(100dvh - var(--spacing-6))"
    >
      {isPickingProject ? (
        <Layout
          header={
            <DialogHeader
              title="选择 Project 目录"
              subtitle="浏览运行 Connect Service 的主机。"
              onOpenChange={onOpenChange}
            />
          }
          content={
            <LayoutContent className="new-session-dialog-content">
              <HostDirectoryPicker
                onCancel={() => setIsPickingProject(false)}
                onSelect={(directory) => {
                  setPendingProject(directory);
                  setWorkspaceSelection("pending-project");
                  setIsPickingProject(false);
                }}
              />
            </LayoutContent>
          }
        />
      ) : (
        <Layout
          header={
            <DialogHeader title="新建 Session" subtitle="一次选择工作区和运行选项。" onOpenChange={onOpenChange} />
          }
          content={
            <LayoutContent className="new-session-dialog-content">
              <VStack gap={4}>
                <TextInput label="名称" value={name} onChange={setName} isOptional width="100%" />
                <Selector
                  label="Agent Binding"
                  options={bindings.map((candidate) => ({
                    value: candidate.bindingId,
                    label: `${candidate.displayName} (${candidate.bindingId})`,
                  }))}
                  value={bindingId}
                  onChange={changeBinding}
                  width="100%"
                />
                <Selector
                  label="Project"
                  options={[
                    { value: "none", label: "Non-Project（隔离工作区）" },
                    ...workspaceOptions,
                    ...(pendingProject
                      ? [{ value: "pending-project", label: `新 Project · ${projectDirectoryLabel(pendingProject)}` }]
                      : []),
                    { value: "create-project", label: "创建新 Project…" },
                  ]}
                  value={workspaceSelection}
                  onChange={(value) => {
                    if (value === "create-project") {
                      setIsPickingProject(true);
                      return;
                    }
                    setWorkspaceSelection(value);
                    if (value !== "pending-project") setPendingProject(null);
                  }}
                  width="100%"
                />
                <Selector
                  label="模式"
                  options={[
                    { value: "default", label: "默认模式" },
                    ...(binding?.modeOptions.map((value) => ({ value, label: value })) ?? []),
                  ]}
                  value={mode}
                  onChange={setMode}
                  width="100%"
                />
                <Selector
                  label="模型"
                  options={[
                    { value: "default", label: "继承 Agent Binding / Runtime 默认值" },
                    ...(binding?.modelOptions.map((option) => ({
                      value: option.id,
                      label: `${option.displayName} (${option.id})`,
                    })) ?? []),
                  ]}
                  value={model}
                  onChange={(value) => {
                    const option = binding?.modelOptions.find((candidate) => candidate.id === value);
                    setModel(value);
                    setReasoningEffort(option?.defaultReasoningEffort ?? "default");
                  }}
                  isDisabled={!binding || binding.modelOptions.length === 0}
                  disabledMessage="Runtime Adapter 不支持模型选择。"
                  width="100%"
                />
                <Selector
                  label="推理强度"
                  options={selectedModel?.supportedReasoningEfforts ?? ["default"]}
                  value={reasoningEffort}
                  onChange={setReasoningEffort}
                  isDisabled={!selectedModel}
                  disabledMessage="先选择一个 Session 模型。"
                  width="100%"
                />
                {create.isError ? <Banner status="error" title="创建失败" description={create.error.message} /> : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} justify="end">
                <Button label="取消" onClick={() => onOpenChange(false)} />
                <Button
                  label="创建 Session"
                  variant="primary"
                  isLoading={create.isPending}
                  isDisabled={!bindingId}
                  onClick={() => create.mutate()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      )}
    </Dialog>
  );
}

function newSessionWorkspaceOptions(
  bindings: SessionCatalogBindingView[],
  bindingId: string,
  projects: ProjectView[],
): { value: string; label: string }[] {
  const options = new Map<string, { value: string; label: string }>();
  for (const entry of bindings.find((binding) => binding.bindingId === bindingId)?.entries ?? []) {
    if (entry.isArchived || !entry.workspaceId || !entry.workspaceName) continue;
    options.set(entry.workspaceId, {
      value: entry.workspaceId,
      label: entry.workspaceName,
    });
  }
  for (const project of projects) {
    options.set(project.workspaceId, {
      value: project.workspaceId,
      label: `${project.name} · ${project.rootPath}`,
    });
  }
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
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
  const status = sessionStatus(entry);
  return {
    id: entry.sessionRef,
    label: entry.name,
    startContent: <ThreadIcon />,
    endContent: status ? (
      <StatusDot variant={status.variant} label={status.label} isPulsing={status.isPulsing} />
    ) : undefined,
    isSelected: entry.sessionRef === selectedRef,
    href: `/sessions/${entry.sessionRef}`,
    onClick: (event) => {
      event.preventDefault();
      open(entry.sessionRef);
    },
  };
}

type SessionStatusView = {
  variant: "success" | "warning" | "error";
  label: string;
  isPulsing?: boolean;
};

function sessionStatus(entry: SessionCatalogEntryView): SessionStatusView | null {
  if (entry.isArchived || entry.status === "idle" || entry.status === "offline") return null;
  const statuses: Partial<Record<SessionCatalogEntryView["status"], SessionStatusView>> = {
    running: { variant: "success", label: "运行中", isPulsing: true },
    queued: { variant: "warning", label: "排队中" },
    error: { variant: "error", label: "错误" },
  };
  return statuses[entry.status] ?? null;
}

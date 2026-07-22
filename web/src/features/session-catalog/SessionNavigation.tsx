import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector } from "@astryxdesign/core/Selector";
import { SideNav, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TreeList, type TreeListItemData } from "@astryxdesign/core/TreeList";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type {
  BindingPreferenceView,
  ProjectView,
  SessionCatalogBindingView,
  SessionCatalogEntryView,
} from "../../../../src/client-contract";
import {
  bootstrapQueryOptions,
  catalogQueryOptions,
  clientKeys,
  createSession,
  projectsQueryOptions,
} from "../../client-interface/query-options";
import { FolderIcon, RefreshIcon, ThreadIcon } from "../../components/icons";

export function SessionNavigation() {
  const catalog = useQuery(catalogQueryOptions);
  const bootstrap = useQuery(bootstrapQueryOptions);
  const projects = useQuery(projectsQueryOptions);
  const navigate = useNavigate();
  const [newSessionOpen, setNewSessionOpen] = useState(false);
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
    <>
      <SideNav
        className="session-nav"
        collapsible={{ buttonLabel: "折叠 Session 导航" }}
        resizable={{ defaultWidth: 304, minWidth: 248, maxWidth: 440, autoSaveId: "connect-client-session-nav" }}
        topContent={
          <div className="session-nav-tools">
            <Button label="新建 Session" size="sm" variant="primary" onClick={() => setNewSessionOpen(true)} />
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
                <p className="nav-empty">没有匹配的 Session</p>
              )}
            </SideNavSection>
          ))
        )}
      </SideNav>
      <NewSessionDialog
        isOpen={newSessionOpen}
        bindings={bootstrap.data?.bindings ?? []}
        projects={projects.data ?? []}
        onOpenChange={setNewSessionOpen}
        onCreated={(sessionRef) => {
          setNewSessionOpen(false);
          void navigate({ to: "/sessions/$sessionRef", params: { sessionRef } });
        }}
      />
    </>
  );
}

function NewSessionDialog({
  isOpen,
  bindings,
  projects,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  bindings: BindingPreferenceView[];
  projects: ProjectView[];
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionRef: string) => void;
}) {
  const queryClient = useQueryClient();
  const [bindingId, setBindingId] = useState(bindings[0]?.bindingId ?? "");
  const [projectId, setProjectId] = useState("none");
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");
  const [mode, setMode] = useState("default");
  const [model, setModel] = useState("default");
  const [reasoningEffort, setReasoningEffort] = useState("default");
  useEffect(() => {
    if (!bindings.some((binding) => binding.bindingId === bindingId)) setBindingId(bindings[0]?.bindingId ?? "");
  }, [bindingId, bindings]);
  const binding = bindings.find((candidate) => candidate.bindingId === bindingId) ?? bindings[0];
  const selectedModel = binding?.modelOptions.find((candidate) => candidate.id === model);
  const create = useMutation({
    mutationFn: async () =>
      await createSession({
        prompt,
        bindingId,
        projectId: projectId === "none" ? null : projectId,
        name: name.trim() || null,
        mode: mode === "default" ? null : mode,
        model: model === "default" ? null : model,
        reasoningEffort: model === "default" ? null : reasoningEffort,
      }),
    onSuccess: (session) => {
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
      queryClient.setQueryData(clientKeys.session(session.sessionRef), session);
      onCreated(session.sessionRef);
    },
  });
  const changeBinding = (value: string) => {
    setBindingId(value);
    setMode("default");
    setModel("default");
    setReasoningEffort("default");
  };
  return (
    <Dialog isOpen={isOpen} onOpenChange={onOpenChange} purpose="form" width={520}>
      <Layout
        height="auto"
        header={<DialogHeader title="新建 Session" subtitle="一次选择工作区和运行选项。" onOpenChange={onOpenChange} />}
        content={
          <LayoutContent isScrollable={false}>
            <div className="new-session-form">
              <TextInput label="名称" value={name} onChange={setName} isOptional width="100%" />
              <TextArea
                label="首个任务"
                value={prompt}
                onChange={setPrompt}
                placeholder="描述要交给 coding agent 的任务"
                width="100%"
              />
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
                  ...projects.map((project) => ({ value: project.projectId, label: project.name })),
                ]}
                value={projectId}
                onChange={setProjectId}
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
              {create.isError ? <p className="form-error">创建失败：{create.error.message}</p> : null}
            </div>
          </LayoutContent>
        }
        footer={
          <LayoutFooter hasDivider>
            <div className="dialog-actions">
              <Button label="取消" onClick={() => onOpenChange(false)} />
              <Button
                label="创建 Session"
                variant="primary"
                isLoading={create.isPending}
                isDisabled={!bindingId || !prompt.trim()}
                onClick={() => create.mutate()}
              />
            </div>
          </LayoutFooter>
        }
      />
    </Dialog>
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

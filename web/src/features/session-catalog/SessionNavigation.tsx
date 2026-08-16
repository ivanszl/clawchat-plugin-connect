import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { IconButton } from "@astryxdesign/core/IconButton";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Selector, SelectorOption } from "@astryxdesign/core/Selector";
import { SideNav, SideNavSection } from "@astryxdesign/core/SideNav";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, StackItem, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { TreeList, type TreeListItemData } from "@astryxdesign/core/TreeList";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate, useRouterState } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type {
  BindingPreferenceView,
  SessionCatalogBindingView,
  SessionCatalogEntryView,
  WorkspaceDirectoryRequest,
  WorkspaceView,
} from "../../../../src/client-contract";
import { catalogQueryOptions, createSession, workspacesQueryOptions } from "../../client-interface/query-options";
import { AddIcon, FolderIcon, ThreadIcon } from "../../components/icons";
import { type ClientTranslator, localizedClientError, useClientTranslator } from "../../i18n/client-i18n";
import {
  HostDirectoryPicker,
  workspaceDirectoryLabel,
  workspaceDirectoryName,
} from "../workspaces/HostDirectoryPicker";

export function SessionNavigation({ onNewSession }: { onNewSession: () => void }) {
  const t = useClientTranslator();
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
        items: navigationItems(binding, search, selectedRef, t, (sessionRef) => {
          void navigate({ to: "/sessions/$sessionRef", params: { sessionRef } });
        }),
      })),
    [catalog.data, navigate, search, selectedRef, t],
  );

  return (
    <SideNav
      className="session-nav"
      data-mode={navigationCollapsed ? "collapsed" : "expanded"}
      collapsible={{
        isCollapsed: navigationCollapsed,
        onCollapsedChange: setNavigationCollapsed,
      }}
      resizable={{ defaultWidth: 304, minWidth: 248, maxWidth: 440, autoSaveId: "connect-client-session-nav" }}
      topContent={
        <HStack gap={2} padding={2} align="end" justify={navigationCollapsed ? "center" : "start"}>
          {navigationCollapsed ? null : (
            <StackItem size="fill">
              <TextInput
                label={t("@connect.navigation.search.label")}
                isLabelHidden
                value={search}
                onChange={setSearch}
                placeholder={t("@connect.navigation.search.placeholder")}
                hasClear
                width="100%"
              />
            </StackItem>
          )}
          <Button
            label={t("@connect.navigation.newSession")}
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
          <Spinner label={t("@connect.navigation.loading")} />
        </VStack>
      ) : catalog.isError ? (
        <Text color="secondary" display="block" justify="center">
          {t("@connect.navigation.loadFailure")}
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
                    ? t("@connect.navigation.connected")
                    : binding.status === "disconnected"
                      ? t("@connect.navigation.disconnected")
                      : t("@connect.navigation.unknownStatus")
                }
                isPulsing={binding.status === "connected"}
              />
            }
          >
            {items.length > 0 ? (
              <TreeList items={items} density="compact" />
            ) : (
              <Text color="secondary" display="block" justify="center">
                {t("@connect.navigation.noMatches")}
              </Text>
            )}
          </SideNavSection>
        ))
      )}
    </SideNav>
  );
}

export function NewSessionDialog({
  isOpen,
  bindings,
  catalogBindings,
  onOpenChange,
  onCreated,
}: {
  isOpen: boolean;
  bindings: BindingPreferenceView[];
  catalogBindings: SessionCatalogBindingView[];
  onOpenChange: (open: boolean) => void;
  onCreated: (sessionRef: string) => void;
}) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [bindingId, setBindingId] = useState(bindings[0]?.bindingId ?? "");
  const [workspaceSelection, setWorkspaceSelection] = useState("");
  const [pendingWorkspace, setPendingWorkspace] = useState<WorkspaceDirectoryRequest | null>(null);
  const [isPickingWorkspace, setIsPickingWorkspace] = useState(false);
  const [name, setName] = useState("");
  const [mode, setMode] = useState("default");
  const [model, setModel] = useState("default");
  const [reasoningEffort, setReasoningEffort] = useState("default");
  useEffect(() => {
    if (!bindings.some((binding) => binding.bindingId === bindingId)) setBindingId(bindings[0]?.bindingId ?? "");
  }, [bindingId, bindings]);
  useEffect(() => {
    if (isOpen) return;
    setIsPickingWorkspace(false);
    setPendingWorkspace(null);
    setWorkspaceSelection("");
  }, [isOpen]);
  const binding = bindings.find((candidate) => candidate.bindingId === bindingId) ?? bindings[0];
  const workspaces = useQuery(workspacesQueryOptions(bindingId || null));
  const workspaceOptions = newSessionWorkspaceOptions(catalogBindings, bindingId, workspaces.data ?? []);
  const workspaceOptionDescriptions = new Map(
    workspaceOptions.flatMap((option) => (option.description ? [[option.value, option.description]] : [])),
  );
  if (pendingWorkspace) workspaceOptionDescriptions.set("pending-workspace", workspaceDirectoryLabel(pendingWorkspace));
  useEffect(() => {
    if (pendingWorkspace || workspaceOptions.some((option) => option.value === workspaceSelection)) return;
    setWorkspaceSelection(
      workspaces.data?.find((workspace) => workspace.isDefault)?.workspaceRef ?? workspaceOptions[0]?.value ?? "",
    );
  }, [pendingWorkspace, workspaceOptions, workspaceSelection, workspaces.data]);
  const defaultModel =
    binding?.modelOptions.find((candidate) => candidate.id === binding.model) ??
    binding?.modelOptions.find((candidate) => candidate.isDefault) ??
    binding?.modelOptions[0];
  const selectedModel = binding?.modelOptions.find(
    (candidate) => candidate.id === (model === "default" ? defaultModel?.id : model),
  );
  const selectedReasoningEffort =
    model === "default"
      ? (binding?.modelReasoningEffort ?? selectedModel?.defaultReasoningEffort ?? "default")
      : reasoningEffort;
  const nameTooLong = name.trim().length > 200;
  const create = useMutation({
    mutationFn: async () =>
      await createSession({
        bindingId,
        workspace: pendingWorkspace
          ? { kind: "new", directory: pendingWorkspace }
          : { kind: "existing", workspaceRef: workspaceSelection },
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
    setWorkspaceSelection("");
    setPendingWorkspace(null);
    setIsPickingWorkspace(false);
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
      {isPickingWorkspace ? (
        <Layout
          header={
            <DialogHeader
              title={t("@connect.newSession.directory.title")}
              subtitle={t("@connect.newSession.directory.description")}
              onOpenChange={() => setIsPickingWorkspace(false)}
            />
          }
          content={
            <LayoutContent className="new-session-dialog-content">
              <HostDirectoryPicker
                onCancel={() => setIsPickingWorkspace(false)}
                onSelect={(directory) => {
                  setPendingWorkspace(directory);
                  setWorkspaceSelection("pending-workspace");
                  setIsPickingWorkspace(false);
                }}
              />
            </LayoutContent>
          }
        />
      ) : (
        <Layout
          header={
            <DialogHeader
              title={t("@connect.newSession.title")}
              subtitle={t("@connect.newSession.description")}
              onOpenChange={onOpenChange}
            />
          }
          content={
            <LayoutContent className="new-session-dialog-content">
              <VStack gap={4}>
                <TextInput
                  label={t("@connect.newSession.name.label")}
                  description={t("@connect.newSession.name.description")}
                  value={name}
                  onChange={setName}
                  status={nameTooLong ? { type: "error", message: t("@connect.newSession.name.tooLong") } : undefined}
                  width="100%"
                />
                <Selector
                  label={t("@connect.newSession.binding.label")}
                  options={bindings.map((candidate) => ({
                    value: candidate.bindingId,
                    label: `${candidate.displayName} (${candidate.bindingId})`,
                  }))}
                  value={bindingId}
                  onChange={changeBinding}
                  width="100%"
                />
                <VStack className="workspace-selector-field" gap={1}>
                  <HStack align="center" justify="between">
                    <Text type="label">{t("@connect.newSession.workspace.label")}</Text>
                    <IconButton
                      label={t("@connect.newSession.workspace.add")}
                      tooltip={t("@connect.newSession.workspace.add")}
                      icon={<AddIcon />}
                      size="sm"
                      variant="ghost"
                      onClick={() => setIsPickingWorkspace(true)}
                    />
                  </HStack>
                  <Selector
                    label={t("@connect.newSession.workspace.label")}
                    isLabelHidden
                    options={[
                      ...workspaceOptions.map(({ value, label }) => ({ value, label })),
                      ...(pendingWorkspace
                        ? [
                            {
                              value: "pending-workspace",
                              label: workspaceDirectoryName(pendingWorkspace),
                            },
                          ]
                        : []),
                    ]}
                    renderOption={(option) => (
                      <SelectorOption
                        className="workspace-selector-option"
                        label={option.label ?? option.value}
                        description={workspaceOptionDescriptions.get(option.value)}
                      />
                    )}
                    value={workspaceSelection}
                    onChange={(value) => {
                      setWorkspaceSelection(value);
                      if (value !== "pending-workspace") setPendingWorkspace(null);
                    }}
                    width="100%"
                  />
                </VStack>
                <Selector
                  label={t("@connect.newSession.mode.label")}
                  options={[
                    { value: "default", label: t("@connect.newSession.mode.default") },
                    ...(binding?.modeOptions.map((value) => ({ value, label: value })) ?? []),
                  ]}
                  value={mode}
                  onChange={setMode}
                  width="100%"
                />
                <Selector
                  label={t("@connect.newSession.model.label")}
                  options={
                    binding?.modelOptions.map((option) => ({
                      value: option.id,
                      label: `${option.displayName} (${option.id})`,
                    })) ?? []
                  }
                  value={model === "default" ? (defaultModel?.id ?? "") : model}
                  onChange={(value) => {
                    const option = binding?.modelOptions.find((candidate) => candidate.id === value);
                    const usesDefault = value === defaultModel?.id;
                    setModel(usesDefault ? "default" : value);
                    setReasoningEffort(usesDefault ? "default" : (option?.defaultReasoningEffort ?? "default"));
                  }}
                  isDisabled={!binding || binding.modelOptions.length === 0}
                  disabledMessage={t("@connect.newSession.model.unsupported")}
                  width="100%"
                />
                <Selector
                  label={t("@connect.newSession.reasoning.label")}
                  options={selectedModel?.supportedReasoningEfforts ?? ["default"]}
                  value={selectedReasoningEffort}
                  onChange={(value) => {
                    if (model === "default" && selectedModel) setModel(selectedModel.id);
                    setReasoningEffort(value);
                  }}
                  isDisabled={!selectedModel}
                  disabledMessage={t("@connect.newSession.reasoning.selectModel")}
                  width="100%"
                />
                {create.isError ? (
                  <Banner
                    status="error"
                    title={t("@connect.newSession.failure")}
                    description={localizedClientError(t, create.error)}
                  />
                ) : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} justify="end">
                <Button label={t("@connect.newSession.cancel")} onClick={() => onOpenChange(false)} />
                <Button
                  label={t("@connect.newSession.create")}
                  variant="primary"
                  isLoading={create.isPending}
                  isDisabled={!bindingId || !workspaceSelection || nameTooLong}
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
  workspaces: WorkspaceView[],
): { value: string; label: string; description?: string }[] {
  const options = new Map<string, { value: string; label: string; description?: string }>();
  for (const entry of bindings.find((binding) => binding.bindingId === bindingId)?.entries ?? []) {
    if (entry.isArchived || !entry.workspaceName) continue;
    options.set(entry.workspaceRef, {
      value: entry.workspaceRef,
      label: entry.workspaceName,
    });
  }
  for (const workspace of workspaces) {
    options.set(workspace.workspaceRef, {
      value: workspace.workspaceRef,
      label: workspace.name,
      description: workspace.rootPath,
    });
  }
  return [...options.values()].sort((left, right) => left.label.localeCompare(right.label));
}

function navigationItems(
  binding: SessionCatalogBindingView,
  search: string,
  selectedRef: string | null,
  t: ClientTranslator,
  open: (sessionRef: string) => void,
): TreeListItemData[] {
  const needle = search.trim().toLocaleLowerCase();
  const visible = binding.entries.filter((entry) => {
    if (!needle) return true;
    return [entry.name, entry.workspaceName, entry.sessionRef].some((value) =>
      value?.toLocaleLowerCase().includes(needle),
    );
  });
  const active = visible.filter((entry) => !entry.isArchived);
  const archived = visible.filter((entry) => entry.isArchived);
  const items = groupedItems(active, "active", selectedRef, needle, t, open);
  if (archived.length > 0) {
    items.push({
      id: `archived:${binding.bindingId}`,
      label: t("@connect.navigation.archived", { count: archived.length }),
      startContent: <FolderIcon />,
      isExpanded: archived.some((entry) => entry.sessionRef === selectedRef) || Boolean(needle),
      children: groupedItems(archived, "archived", selectedRef, needle, t, open),
    });
  }
  return items;
}

function groupedItems(
  entries: SessionCatalogEntryView[],
  prefix: string,
  selectedRef: string | null,
  search: string,
  t: ClientTranslator,
  open: (sessionRef: string) => void,
): TreeListItemData[] {
  const workspaces = new Map<string, SessionCatalogEntryView[]>();
  for (const entry of entries) {
    const workspaceEntries = workspaces.get(entry.workspaceRef) ?? [];
    workspaceEntries.push(entry);
    workspaces.set(entry.workspaceRef, workspaceEntries);
  }
  return [...workspaces.entries()].map(([workspaceRef, workspaceEntries]) => ({
    id: `${prefix}:workspace:${workspaceRef}`,
    label: workspaceEntries[0]?.workspaceName || t("@connect.navigation.unnamedWorkspace"),
    startContent: <FolderIcon />,
    isExpanded: workspaceEntries.some((entry) => entry.sessionRef === selectedRef) || Boolean(search),
    children: workspaceEntries.map((entry) => sessionItem(entry, selectedRef, t, open)),
  }));
}

function sessionItem(
  entry: SessionCatalogEntryView,
  selectedRef: string | null,
  t: ClientTranslator,
  open: (sessionRef: string) => void,
): TreeListItemData {
  const status = sessionStatus(entry, t);
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

function sessionStatus(entry: SessionCatalogEntryView, t: ClientTranslator): SessionStatusView | null {
  if (entry.isArchived || entry.status === "idle" || entry.status === "offline") return null;
  const statuses: Partial<Record<SessionCatalogEntryView["status"], SessionStatusView>> = {
    running: { variant: "success", label: t("@connect.navigation.status.running"), isPulsing: true },
    queued: { variant: "warning", label: t("@connect.navigation.status.queued") },
    error: { variant: "error", label: t("@connect.navigation.status.error") },
  };
  return statuses[entry.status] ?? null;
}

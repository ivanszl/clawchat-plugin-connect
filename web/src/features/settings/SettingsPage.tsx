import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import type { BindingPreferenceView, BootstrapView, ProjectDirectoryRequest } from "../../../../src/client-contract";
import {
  addProject,
  bootstrapQueryOptions,
  catalogQueryOptions,
  clientKeys,
  projectsQueryOptions,
  removeProject,
  updateBindingPreferences,
} from "../../client-interface/query-options";
import { localizedClientError, settingsClientErrorKeys, useClientTranslator } from "../../i18n/client-i18n";
import { HostDirectoryPicker, projectDirectoryLabel } from "../projects/HostDirectoryPicker";

type ProjectListItem = { workspaceId: string; name: string; rootPath: string };

export function SettingsPage() {
  const t = useClientTranslator();
  const bootstrap = useQuery(bootstrapQueryOptions);
  const projects = useQuery(projectsQueryOptions);
  if (!bootstrap.data) return null;
  return (
    <Layout
      height="fill"
      contentWidth={960}
      content={
        <LayoutContent padding={6} label={t("@connect.settings.title")}>
          <VStack gap={6}>
            <VStack gap={1} as="header">
              <Text type="label" color="secondary">
                CONNECT CLIENT
              </Text>
              <Heading level={1}>{t("@connect.settings.title")}</Heading>
              <Text type="supporting">{t("@connect.settings.description")}</Text>
            </VStack>
            <VStack gap={4}>
              {bootstrap.data.bindings.map((binding) => (
                <BindingSettings key={binding.bindingId} binding={binding} />
              ))}
              <ProjectSettings
                projects={projects.data ?? []}
                isLoading={projects.isPending}
                loadError={projects.error}
              />
            </VStack>
          </VStack>
        </LayoutContent>
      }
    />
  );
}

function BindingSettings({ binding }: { binding: BindingPreferenceView }) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(binding.displayName);
  const [model, setModel] = useState(binding.model ?? "");
  const [effort, setEffort] = useState(binding.modelReasoningEffort ?? "default");
  const [visibility, setVisibility] = useState(binding.outputVisibility);
  const selectedModel =
    binding.modelOptions.find((option) => option.id === model) ??
    binding.modelOptions.find((option) => option.isDefault) ??
    binding.modelOptions[0];
  const effortOptions = [
    { value: "default", label: t("@connect.settings.binding.reasoning.default") },
    ...(selectedModel?.supportedReasoningEfforts ?? []).map((value) => ({ value, label: value })),
  ];
  useEffect(() => {
    setDisplayName(binding.displayName);
    setModel(binding.model ?? "");
    setEffort(binding.modelReasoningEffort ?? "default");
    setVisibility(binding.outputVisibility);
  }, [binding]);
  const save = useMutation({
    mutationFn: async () =>
      await updateBindingPreferences(binding.bindingId, {
        displayName,
        model: model.trim() || null,
        modelReasoningEffort: effort === "default" ? null : effort,
        outputVisibility: visibility,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.bootstrap });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  return (
    <Card padding={4}>
      <VStack gap={4}>
        <HStack gap={4} hAlign="between" align="center" wrap="wrap" as="header">
          <VStack gap={0.5}>
            <Heading level={2}>{binding.displayName}</Heading>
            <Text type="code" color="secondary">
              {binding.bindingId}
            </Text>
          </VStack>
          <Button
            label={t(save.isPending ? "@connect.settings.binding.saving" : "@connect.settings.binding.save")}
            variant="primary"
            isLoading={save.isPending}
            onClick={() => save.mutate()}
          />
        </HStack>
        {save.isSuccess ? (
          <Banner status="success" title={t("@connect.settings.binding.saved")} container="section" />
        ) : null}
        {save.isError ? (
          <Banner
            status="error"
            title={t("@connect.settings.binding.saveFailed")}
            description={localizedClientError(t, save.error, settingsClientErrorKeys)}
            container="section"
          />
        ) : null}
        <Grid columns={{ minWidth: 280, max: 2 }} gap={4}>
          <SettingsField>
            <TextInput
              label={t("@connect.settings.binding.displayName")}
              value={displayName}
              onChange={setDisplayName}
              width="100%"
            />
          </SettingsField>
          <SettingsField description={t("@connect.settings.binding.model.description")}>
            <Selector
              label={t("@connect.settings.binding.model.label")}
              options={[
                { value: "default", label: t("@connect.settings.binding.model.default") },
                ...binding.modelOptions.map((option) => ({
                  value: option.id,
                  label: `${option.displayName} (${option.id})`,
                })),
              ]}
              value={model || "default"}
              onChange={(value) => {
                const option = binding.modelOptions.find((candidate) => candidate.id === value);
                setModel(value === "default" ? "" : value);
                setEffort(option?.defaultReasoningEffort ?? "default");
              }}
              isDisabled={binding.modelOptions.length === 0}
              disabledMessage={t("@connect.settings.binding.model.disabled")}
              width="100%"
            />
          </SettingsField>
          <SettingsField>
            <Selector
              label={t("@connect.settings.binding.reasoning.label")}
              options={effortOptions}
              value={effort}
              onChange={setEffort}
              isDisabled={!selectedModel}
              disabledMessage={t("@connect.settings.binding.reasoning.disabled")}
              width="100%"
            />
          </SettingsField>
          <SettingsField description={t("@connect.settings.binding.visibility.description")}>
            <Selector
              label={t("@connect.settings.binding.visibility.label")}
              options={[
                { value: "minimal", label: t("@connect.settings.binding.visibility.minimal") },
                { value: "normal", label: t("@connect.settings.binding.visibility.normal") },
                { value: "full", label: t("@connect.settings.binding.visibility.full") },
              ]}
              value={visibility}
              onChange={(value) => setVisibility(value as BootstrapView["outputVisibility"])}
              width="100%"
            />
          </SettingsField>
        </Grid>
      </VStack>
    </Card>
  );
}

function ProjectSettings({
  projects,
  isLoading,
  loadError,
}: {
  projects: ProjectListItem[];
  isLoading: boolean;
  loadError: Error | null;
}) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [directory, setDirectory] = useState<ProjectDirectoryRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removalTarget, setRemovalTarget] = useState<ProjectListItem | null>(null);
  const [lastRemovedProject, setLastRemovedProject] = useState<ProjectListItem | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      if (!directory) throw new Error(t("@connect.settings.projects.selectRequired"));
      return await addProject(directory);
    },
    onSuccess: () => {
      setDirectory(null);
      setLastRemovedProject(null);
      void queryClient.invalidateQueries({ queryKey: clientKeys.projects });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: async (project: ProjectListItem) => await removeProject(project.workspaceId),
    onSuccess: (_data, project) => {
      setLastRemovedProject(project);
      void queryClient.invalidateQueries({ queryKey: clientKeys.projects });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
    onSettled: () => setRemovalTarget(null),
  });
  return (
    <>
      <Card padding={4}>
        <VStack gap={4}>
          <HStack gap={4} hAlign="between" align="start" wrap="wrap" as="header">
            <VStack gap={1}>
              <Heading level={2}>{t("@connect.settings.projects.title")}</Heading>
              <Text type="supporting">{t("@connect.settings.projects.description")}</Text>
            </VStack>
            <HStack gap={2} wrap="wrap">
              <Button
                label={t("@connect.settings.projects.chooseDirectory")}
                variant="secondary"
                onClick={() => setPickerOpen(true)}
              />
              <Button
                label={t(add.isPending ? "@connect.settings.projects.adding" : "@connect.settings.projects.add")}
                variant="primary"
                isLoading={add.isPending}
                isDisabled={!directory}
                onClick={() => add.mutate()}
              />
            </HStack>
          </HStack>
          {directory ? (
            <Section variant="muted">
              <VStack gap={1}>
                <Text type="label">{t("@connect.settings.projects.pendingDirectory")}</Text>
                <Text type="code" display="block" wordBreak="break-all">
                  {projectDirectoryLabel(directory)}
                </Text>
              </VStack>
            </Section>
          ) : null}
          {add.isSuccess ? (
            <Banner
              status="success"
              title={t("@connect.settings.projects.added")}
              description={t("@connect.settings.projects.addedDescription", { project: add.data.name })}
            />
          ) : null}
          {add.isError ? (
            <Banner
              status="error"
              title={t("@connect.settings.projects.addFailed")}
              description={localizedClientError(t, add.error, settingsClientErrorKeys)}
            />
          ) : null}
          {lastRemovedProject && remove.isSuccess ? (
            <Banner
              status="success"
              title={t("@connect.settings.projects.removed")}
              description={t("@connect.settings.projects.removedDescription", {
                project: lastRemovedProject.name,
              })}
            />
          ) : null}
          {remove.isError ? (
            <Banner
              status="error"
              title={t("@connect.settings.projects.removeFailed")}
              description={localizedClientError(t, remove.error, settingsClientErrorKeys)}
            />
          ) : null}
          {loadError ? (
            <Banner
              status="error"
              title={t("@connect.settings.projects.loadFailed")}
              description={localizedClientError(t, loadError, settingsClientErrorKeys)}
            />
          ) : null}
          <List
            density="compact"
            hasDividers
            header={<Text type="label">{t("@connect.settings.projects.registered")}</Text>}
          >
            {isLoading ? <ListItem label={t("@connect.settings.projects.loading")} isDisabled /> : null}
            {!isLoading && projects.length === 0 ? (
              <ListItem label={t("@connect.settings.projects.empty")} isDisabled />
            ) : null}
            {projects.map((project) => (
              <ListItem
                key={project.workspaceId}
                label={project.name}
                description={
                  <VStack gap={0.5}>
                    <Text type="code" wordBreak="break-all">
                      {project.rootPath}
                    </Text>
                    <Text type="code" wordBreak="break-all">
                      {t("@connect.settings.projects.workspaceId", { workspaceId: project.workspaceId })}
                    </Text>
                  </VStack>
                }
                endContent={
                  <Button
                    label={t("@connect.settings.projects.removeAccessible", { project: project.name })}
                    size="sm"
                    onClick={() => setRemovalTarget(project)}
                  >
                    {t("@connect.settings.projects.remove")}
                  </Button>
                }
              />
            ))}
          </List>
        </VStack>
      </Card>
      <Dialog
        isOpen={pickerOpen}
        onOpenChange={setPickerOpen}
        purpose="form"
        width={640}
        maxHeight="calc(100dvh - var(--spacing-6))"
      >
        <Layout
          header={
            <DialogHeader
              title={t("@connect.settings.projects.directoryDialog.title")}
              subtitle={t("@connect.settings.projects.directoryDialog.description")}
              onOpenChange={setPickerOpen}
            />
          }
          content={
            <LayoutContent>
              <HostDirectoryPicker
                onCancel={() => setPickerOpen(false)}
                onSelect={(selection) => {
                  setDirectory(selection);
                  setPickerOpen(false);
                }}
              />
            </LayoutContent>
          }
        />
      </Dialog>
      <AlertDialog
        isOpen={Boolean(removalTarget)}
        onOpenChange={(isOpen) => {
          if (!isOpen && !remove.isPending) setRemovalTarget(null);
        }}
        title={t("@connect.settings.projects.removeConfirm.title", { project: removalTarget?.name ?? "" })}
        description={t("@connect.settings.projects.removeConfirm.description", {
          project: removalTarget?.name ?? "",
          path: removalTarget?.rootPath ?? "",
        })}
        actionLabel={t(
          remove.isPending
            ? "@connect.settings.projects.removeConfirm.removing"
            : "@connect.settings.projects.removeConfirm.action",
        )}
        cancelLabel={t("@connect.settings.projects.removeConfirm.cancel")}
        actionVariant="destructive"
        isActionLoading={remove.isPending}
        onAction={() => {
          if (removalTarget) remove.mutate(removalTarget);
        }}
      />
    </>
  );
}

function SettingsField({ children, description }: { children: ReactNode; description?: string }) {
  return (
    <VStack gap={1}>
      {children}
      {description ? <Text type="supporting">{description}</Text> : null}
    </VStack>
  );
}

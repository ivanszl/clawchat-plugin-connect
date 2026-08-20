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
import { Tab, TabList } from "@astryxdesign/core/TabList";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import {
  type BindingPreferenceView,
  type BootstrapView,
  type PluginJsonSchemaView,
  runtimeModelSelectionsEqual,
  type WorkspaceDirectoryRequest,
  type WorkspaceView,
} from "../../../../src/client-contract";
import {
  addWorkspace,
  bootstrapQueryOptions,
  catalogQueryOptions,
  clientKeys,
  pluginAdministrationQueryOptions,
  removeWorkspace,
  updateBindingPreferences,
  upsertBindingProvider,
  workspacesQueryOptions,
} from "../../client-interface/query-options";
import { localizedClientError, settingsClientErrorKeys, useClientTranslator } from "../../i18n/client-i18n";
import { HostDirectoryPicker, workspaceDirectoryLabel } from "../workspaces/HostDirectoryPicker";
import { JsonSchemaForm, PluginSettings, prepareJsonSchemaConfiguration } from "./PluginSettings";

type WorkspaceListItem = WorkspaceView;
type RuntimeCapabilityOption = {
  value: string;
  label: string;
  pluginId: string;
  capabilityId: string;
  configurationSchema: PluginJsonSchemaView;
};

type SettingsTab = "agent" | "workspace" | "plugins";

export function SettingsPage() {
  const t = useClientTranslator();
  const bootstrap = useQuery(bootstrapQueryOptions);
  const plugins = useQuery(pluginAdministrationQueryOptions);
  const [activeTab, setActiveTab] = useState<SettingsTab>("agent");
  const [selectedBindingId, setSelectedBindingId] = useState("");
  const runtimeCapabilities = useMemo(
    () =>
      (plugins.data?.installed ?? [])
        .filter((plugin) => plugin.status === "active")
        .flatMap((plugin) =>
          plugin.capabilities
            .filter((capability) => capability.type === "runtime")
            .map((capability) => ({
              value: runtimeCapabilityValue(plugin.pluginId, capability.id),
              label: t("@connect.settings.binding.provider.option", {
                pluginName: plugin.name,
                pluginId: plugin.pluginId,
                capabilityId: capability.id,
                family: capability.family ?? t("@connect.settings.plugins.none"),
              }),
              pluginId: plugin.pluginId,
              capabilityId: capability.id,
              configurationSchema: capability.configurationSchema,
            })),
        )
        .sort(
          (left, right) =>
            left.pluginId.localeCompare(right.pluginId) || left.capabilityId.localeCompare(right.capabilityId),
        ),
    [plugins.data, t],
  );
  if (!bootstrap.data) return null;
  const bindings = bootstrap.data.bindings;
  const selectedBinding = bindings.find((binding) => binding.bindingId === selectedBindingId) ?? bindings[0] ?? null;

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
            <TabList
              value={activeTab}
              onChange={(value) => setActiveTab(value as SettingsTab)}
              layout="fill"
              hasDivider
            >
              <Tab value="agent" label={t("@connect.settings.tabs.agent")} />
              <Tab value="workspace" label={t("@connect.settings.tabs.workspace")} />
              <Tab value="plugins" label={t("@connect.settings.tabs.plugins")} />
            </TabList>
            {activeTab === "plugins" ? <PluginSettings /> : null}
            {activeTab !== "plugins" ? (
              <VStack gap={4}>
                {selectedBinding ? (
                  <BindingContextSelector
                    bindings={bindings}
                    value={selectedBinding.bindingId}
                    onChange={setSelectedBindingId}
                  />
                ) : null}
                {activeTab === "agent" ? (
                  <VStack gap={4}>
                    {selectedBinding ? (
                      <BindingSettings
                        binding={selectedBinding}
                        runtimeCapabilities={runtimeCapabilities}
                        capabilitiesPending={plugins.isPending}
                        capabilitiesError={plugins.error}
                      />
                    ) : null}
                    <NewBindingSettings
                      runtimeCapabilities={runtimeCapabilities}
                      capabilitiesPending={plugins.isPending}
                      capabilitiesError={plugins.error}
                    />
                  </VStack>
                ) : null}
                {activeTab === "workspace" && selectedBinding ? (
                  <WorkspaceSettings key={selectedBinding.bindingId} binding={selectedBinding} />
                ) : null}
              </VStack>
            ) : null}
          </VStack>
        </LayoutContent>
      }
    />
  );
}

type RuntimeCapabilityProps = {
  runtimeCapabilities: RuntimeCapabilityOption[];
  capabilitiesPending: boolean;
  capabilitiesError: Error | null;
};

function BindingContextSelector({
  bindings,
  value,
  onChange,
}: {
  bindings: BindingPreferenceView[];
  value: string;
  onChange: (value: string) => void;
}) {
  const t = useClientTranslator();
  return (
    <Selector
      label={t("@connect.newSession.binding.label")}
      options={bindings.map((binding) => ({
        value: binding.bindingId,
        label: `${binding.displayName} (${binding.bindingId})`,
      }))}
      value={value}
      onChange={onChange}
      isDisabled={bindings.length < 2}
      width="100%"
    />
  );
}

function NewBindingSettings({ runtimeCapabilities, capabilitiesPending, capabilitiesError }: RuntimeCapabilityProps) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [bindingId, setBindingId] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [providerValue, setProviderValue] = useState("");
  const [runtimeConfiguration, setRuntimeConfiguration] = useState<Record<string, unknown>>({});
  const [invalidConfigurationFieldIds, setInvalidConfigurationFieldIds] = useState(
    () => new Set(["new-binding-provider-schema"]),
  );
  const configurationValid = invalidConfigurationFieldIds.size === 0;
  const selectedCapability = runtimeCapabilities.find((option) => option.value === providerValue);
  const trackConfigurationValidity = useCallback((fieldId: string, valid: boolean) => {
    setInvalidConfigurationFieldIds((current) => updatedInvalidFieldIds(current, fieldId, valid));
  }, []);
  const create = useMutation({
    mutationFn: async () => {
      const normalizedBindingId = bindingId.trim();
      if (!normalizedBindingId) throw new Error(t("@connect.settings.binding.create.bindingIdRequired"));
      if (!selectedCapability) throw new Error(t("@connect.settings.binding.provider.selectionRequired"));
      if (!configurationValid) throw new Error(t("@connect.settings.binding.provider.configurationInvalid"));
      return await upsertBindingProvider(normalizedBindingId, {
        pluginId: selectedCapability.pluginId,
        capabilityId: selectedCapability.capabilityId,
        runtimeConfig: runtimeConfiguration,
        createOnly: true,
        ...(displayName.trim() ? { displayName: displayName.trim() } : {}),
      });
    },
    onSuccess: () => {
      setBindingId("");
      setDisplayName("");
      setProviderValue("");
      setRuntimeConfiguration({});
      setInvalidConfigurationFieldIds(new Set(["new-binding-provider-schema"]));
      void queryClient.invalidateQueries({ queryKey: clientKeys.bootstrap });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
      void queryClient.invalidateQueries({ queryKey: pluginAdministrationQueryOptions.queryKey });
    },
  });
  const selectCapability = (value: string) => {
    const nextCapability = runtimeCapabilities.find((option) => option.value === value);
    setProviderValue(value);
    if (!nextCapability) {
      setRuntimeConfiguration({});
      setInvalidConfigurationFieldIds(new Set(["new-binding-provider-schema"]));
      return;
    }
    const prepared = defaultRuntimeConfiguration(nextCapability, "new-binding-provider");
    setRuntimeConfiguration(prepared.configuration);
    setInvalidConfigurationFieldIds(prepared.invalidFieldIds);
  };
  return (
    <Card padding={4}>
      <VStack gap={4}>
        <VStack gap={1} as="header">
          <Heading level={2}>{t("@connect.settings.binding.create.title")}</Heading>
          <Text type="supporting">{t("@connect.settings.binding.create.description")}</Text>
        </VStack>
        {capabilitiesError ? (
          <Banner
            status="error"
            title={t("@connect.settings.plugins.loadFailed")}
            description={localizedClientError(t, capabilitiesError)}
            container="section"
          />
        ) : null}
        {create.isSuccess ? (
          <Banner status="success" title={t("@connect.settings.binding.create.created")} container="section" />
        ) : null}
        {create.isError ? (
          <Banner
            status="error"
            title={t("@connect.settings.binding.create.createFailed")}
            description={localizedClientError(t, create.error, settingsClientErrorKeys)}
            container="section"
          />
        ) : null}
        <VStack gap={4}>
          <SettingsField description={t("@connect.settings.binding.create.bindingIdDescription")}>
            <TextInput
              label={t("@connect.settings.binding.create.bindingId")}
              value={bindingId}
              onChange={setBindingId}
              isRequired
              width="100%"
            />
          </SettingsField>
          <TextInput
            label={t("@connect.settings.binding.displayName")}
            value={displayName}
            onChange={setDisplayName}
            width="100%"
          />
          <SettingsField description={t("@connect.settings.binding.provider.description")}>
            <Selector
              label={t("@connect.settings.binding.provider.select")}
              options={runtimeCapabilities}
              value={providerValue || undefined}
              onChange={selectCapability}
              isRequired
              isDisabled={capabilitiesPending || Boolean(capabilitiesError) || runtimeCapabilities.length === 0}
              disabledMessage={t(runtimeCapabilityUnavailableMessage(capabilitiesPending, Boolean(capabilitiesError)))}
              width="100%"
            />
          </SettingsField>
          {selectedCapability ? (
            <VStack gap={2}>
              <Heading level={3}>{t("@connect.settings.binding.provider.configuration")}</Heading>
              <JsonSchemaForm
                key={selectedCapability.value}
                schema={selectedCapability.configurationSchema}
                value={runtimeConfiguration}
                onChange={setRuntimeConfiguration}
                prefix="new-binding-provider"
                fallbackLabel={t("@connect.settings.binding.provider.configuration")}
                onValidityChange={trackConfigurationValidity}
              />
            </VStack>
          ) : null}
        </VStack>
        <HStack justify="end">
          <Button
            label={t(
              create.isPending
                ? "@connect.settings.binding.create.creating"
                : "@connect.settings.binding.create.create",
            )}
            variant="primary"
            isLoading={create.isPending}
            isDisabled={!bindingId.trim() || !selectedCapability || !configurationValid}
            onClick={() => create.mutate()}
          />
        </HStack>
      </VStack>
    </Card>
  );
}

function BindingSettings({
  binding,
  runtimeCapabilities,
  capabilitiesPending,
  capabilitiesError,
}: { binding: BindingPreferenceView } & RuntimeCapabilityProps) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(binding.displayName);
  const [model, setModel] = useState(
    binding.modelOptions.find((option) => runtimeModelSelectionsEqual(option.selection, binding.model))?.id ?? "",
  );
  const [effort, setEffort] = useState(binding.modelReasoningEffort ?? "default");
  const [visibility, setVisibility] = useState(binding.outputVisibility);
  const [providerValue, setProviderValue] = useState(
    runtimeCapabilityValue(binding.runtimePluginId, binding.runtimeCapabilityId),
  );
  const [runtimeConfiguration, setRuntimeConfiguration] = useState(binding.runtimeConfiguration);
  const [invalidConfigurationFieldIds, setInvalidConfigurationFieldIds] = useState(() => new Set<string>());
  const configurationValid = invalidConfigurationFieldIds.size === 0;
  const selectedCapability = runtimeCapabilities.find((option) => option.value === providerValue);
  const currentCapability = runtimeCapabilities.find(
    (option) => option.pluginId === binding.runtimePluginId && option.capabilityId === binding.runtimeCapabilityId,
  );
  const selectedModel =
    binding.modelOptions.find((option) => option.id === model) ??
    binding.modelOptions.find((option) => option.isDefault) ??
    binding.modelOptions[0];
  const effortOptions = [
    { value: "default", label: t("@connect.settings.binding.reasoning.default") },
    ...(selectedModel?.supportedReasoningEfforts ?? []).map((value) => ({ value, label: value })),
  ];
  const trackConfigurationValidity = useCallback((fieldId: string, valid: boolean) => {
    setInvalidConfigurationFieldIds((current) => updatedInvalidFieldIds(current, fieldId, valid));
  }, []);
  useEffect(() => {
    setDisplayName(binding.displayName);
    setModel(
      binding.modelOptions.find((option) => runtimeModelSelectionsEqual(option.selection, binding.model))?.id ?? "",
    );
    setEffort(binding.modelReasoningEffort ?? "default");
    setVisibility(binding.outputVisibility);
    setProviderValue(runtimeCapabilityValue(binding.runtimePluginId, binding.runtimeCapabilityId));
    setRuntimeConfiguration(binding.runtimeConfiguration);
    setInvalidConfigurationFieldIds(new Set());
  }, [
    binding.displayName,
    binding.model,
    binding.modelOptions,
    binding.modelReasoningEffort,
    binding.outputVisibility,
    binding.runtimePluginId,
    binding.runtimeCapabilityId,
    binding.runtimeConfiguration,
  ]);
  const save = useMutation({
    mutationFn: async () =>
      await updateBindingPreferences(binding.bindingId, {
        displayName,
        model: selectedModel && model ? selectedModel.selection : null,
        modelReasoningEffort: effort === "default" ? null : effort,
        outputVisibility: visibility,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.bootstrap });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  const saveProvider = useMutation({
    mutationFn: async () => {
      if (!selectedCapability) throw new Error(t("@connect.settings.binding.provider.selectionRequired"));
      if (!configurationValid) throw new Error(t("@connect.settings.binding.provider.configurationInvalid"));
      return await upsertBindingProvider(binding.bindingId, {
        pluginId: selectedCapability.pluginId,
        capabilityId: selectedCapability.capabilityId,
        runtimeConfig: runtimeConfiguration,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.bootstrap });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
      void queryClient.invalidateQueries({ queryKey: pluginAdministrationQueryOptions.queryKey });
    },
  });
  const selectCapability = (value: string) => {
    if (value === providerValue) return;
    const nextCapability = runtimeCapabilities.find((option) => option.value === value);
    setProviderValue(value);
    if (!nextCapability) {
      setRuntimeConfiguration({});
      setInvalidConfigurationFieldIds(new Set([`${binding.bindingId}-provider-schema`]));
      return;
    }
    const prepared = defaultRuntimeConfiguration(nextCapability, `${binding.bindingId}-provider`);
    setRuntimeConfiguration(prepared.configuration);
    setInvalidConfigurationFieldIds(prepared.invalidFieldIds);
  };
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
        <VStack gap={2}>
          <Heading level={3}>{t("@connect.settings.binding.provider.title")}</Heading>
          <Text type={currentCapability ? "supporting" : "code"} wordBreak="break-all">
            {currentCapability
              ? currentCapability.label
              : t("@connect.settings.binding.provider.identity", {
                  pluginId: binding.runtimePluginId,
                  capabilityId: binding.runtimeCapabilityId,
                })}
          </Text>
        </VStack>
        {binding.clawChatUserId !== null ? (
          <Banner
            status="info"
            title={t("@connect.settings.binding.provider.lockedTitle")}
            description={t("@connect.settings.binding.provider.lockedDescription")}
            container="section"
          />
        ) : (
          <VStack gap={4}>
            {saveProvider.isSuccess ? (
              <Banner status="success" title={t("@connect.settings.binding.saved")} container="section" />
            ) : null}
            {saveProvider.isError ? (
              <Banner
                status="error"
                title={t("@connect.settings.binding.saveFailed")}
                description={localizedClientError(t, saveProvider.error, settingsClientErrorKeys)}
                container="section"
              />
            ) : null}
            <SettingsField description={t("@connect.settings.binding.provider.description")}>
              <Selector
                label={t("@connect.settings.binding.provider.select")}
                options={runtimeCapabilities}
                value={providerValue}
                onChange={selectCapability}
                isRequired
                isDisabled={capabilitiesPending || Boolean(capabilitiesError) || runtimeCapabilities.length === 0}
                disabledMessage={t(
                  runtimeCapabilityUnavailableMessage(capabilitiesPending, Boolean(capabilitiesError)),
                )}
                width="100%"
              />
            </SettingsField>
            {selectedCapability ? (
              <VStack gap={2}>
                <Heading level={3}>{t("@connect.settings.binding.provider.configuration")}</Heading>
                <JsonSchemaForm
                  key={selectedCapability.value}
                  schema={selectedCapability.configurationSchema}
                  value={runtimeConfiguration}
                  onChange={setRuntimeConfiguration}
                  prefix={`${binding.bindingId}-provider`}
                  fallbackLabel={t("@connect.settings.binding.provider.configuration")}
                  onValidityChange={trackConfigurationValidity}
                />
              </VStack>
            ) : null}
            <HStack justify="end">
              <Button
                label={t(
                  saveProvider.isPending
                    ? "@connect.settings.binding.saving"
                    : "@connect.settings.plugins.configure.save",
                )}
                variant="secondary"
                isLoading={saveProvider.isPending}
                isDisabled={!selectedCapability || !configurationValid}
                onClick={() => saveProvider.mutate()}
              />
            </HStack>
          </VStack>
        )}
      </VStack>
    </Card>
  );
}

function runtimeCapabilityValue(pluginId: string, capabilityId: string): string {
  return JSON.stringify([pluginId, capabilityId]);
}

function runtimeCapabilityUnavailableMessage(capabilitiesPending: boolean, capabilitiesError: boolean) {
  if (capabilitiesPending) return "@connect.settings.plugins.loading" as const;
  if (capabilitiesError) return "@connect.settings.plugins.loadFailed" as const;
  return "@connect.settings.binding.provider.unavailable" as const;
}

function defaultRuntimeConfiguration(
  capability: RuntimeCapabilityOption,
  prefix: string,
): { configuration: Record<string, unknown>; invalidFieldIds: Set<string> } {
  const invalidFieldIds = new Set<string>();
  const configuration = prepareJsonSchemaConfiguration(capability.configurationSchema, {}, prefix, invalidFieldIds);
  return { configuration, invalidFieldIds };
}

function updatedInvalidFieldIds(current: Set<string>, fieldId: string, valid: boolean): Set<string> {
  const isInvalid = current.has(fieldId);
  if ((valid && !isInvalid) || (!valid && isInvalid)) return current;
  const next = new Set(current);
  if (valid) next.delete(fieldId);
  else next.add(fieldId);
  return next;
}

function WorkspaceSettings({ binding }: { binding: BindingPreferenceView }) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const bindingId = binding.bindingId;
  const workspaces = useQuery(workspacesQueryOptions(bindingId));
  const [directory, setDirectory] = useState<WorkspaceDirectoryRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [removalTarget, setRemovalTarget] = useState<WorkspaceListItem | null>(null);
  const [lastRemovedWorkspace, setLastRemovedWorkspace] = useState<WorkspaceListItem | null>(null);
  const add = useMutation({
    mutationFn: async () => {
      if (!directory) throw new Error(t("@connect.settings.workspaces.selectRequired"));
      return await addWorkspace(bindingId, directory);
    },
    onSuccess: () => {
      setDirectory(null);
      setLastRemovedWorkspace(null);
      void queryClient.invalidateQueries({ queryKey: clientKeys.workspaces(bindingId) });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: async (workspace: WorkspaceListItem) => await removeWorkspace(bindingId, workspace.workspaceRef),
    onSuccess: (_data, workspace) => {
      setLastRemovedWorkspace(workspace);
      void queryClient.invalidateQueries({ queryKey: clientKeys.workspaces(bindingId) });
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
              <Heading level={2}>{t("@connect.settings.workspaces.title")}</Heading>
              <Text type="supporting">{t("@connect.settings.workspaces.description")}</Text>
            </VStack>
            <HStack gap={2} wrap="wrap">
              <Button
                label={t("@connect.settings.workspaces.chooseDirectory")}
                variant="secondary"
                onClick={() => setPickerOpen(true)}
              />
              <Button
                label={t(add.isPending ? "@connect.settings.workspaces.adding" : "@connect.settings.workspaces.add")}
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
                <Text type="label">{t("@connect.settings.workspaces.pendingDirectory")}</Text>
                <Text type="code" display="block" wordBreak="break-all">
                  {workspaceDirectoryLabel(directory)}
                </Text>
              </VStack>
            </Section>
          ) : null}
          {add.isSuccess ? (
            <Banner
              status="success"
              title={t("@connect.settings.workspaces.added")}
              description={t("@connect.settings.workspaces.addedDescription", { workspace: add.data.name })}
            />
          ) : null}
          {add.isError ? (
            <Banner
              status="error"
              title={t("@connect.settings.workspaces.addFailed")}
              description={localizedClientError(t, add.error, settingsClientErrorKeys)}
            />
          ) : null}
          {lastRemovedWorkspace && remove.isSuccess ? (
            <Banner
              status="success"
              title={t("@connect.settings.workspaces.removed")}
              description={t("@connect.settings.workspaces.removedDescription", {
                workspace: lastRemovedWorkspace.name,
              })}
            />
          ) : null}
          {remove.isError ? (
            <Banner
              status="error"
              title={t("@connect.settings.workspaces.removeFailed")}
              description={localizedClientError(t, remove.error, settingsClientErrorKeys)}
            />
          ) : null}
          {workspaces.error ? (
            <Banner
              status="error"
              title={t("@connect.settings.workspaces.loadFailed")}
              description={localizedClientError(t, workspaces.error, settingsClientErrorKeys)}
            />
          ) : null}
          <List
            density="compact"
            hasDividers
            header={<Text type="label">{t("@connect.settings.workspaces.registered")}</Text>}
          >
            {workspaces.isPending ? <ListItem label={t("@connect.settings.workspaces.loading")} isDisabled /> : null}
            {!workspaces.isPending && (workspaces.data?.length ?? 0) === 0 ? (
              <ListItem label={t("@connect.settings.workspaces.empty")} isDisabled />
            ) : null}
            {(workspaces.data ?? []).map((workspace) => (
              <ListItem
                key={workspace.workspaceRef}
                label={workspace.name}
                description={
                  <VStack gap={0.5}>
                    <Text type="code" wordBreak="break-all">
                      {workspace.rootPath}
                    </Text>
                    <Text type="code" wordBreak="break-all">
                      {workspace.workspaceRef}
                    </Text>
                  </VStack>
                }
                endContent={
                  workspace.isDefault ? undefined : (
                    <Button
                      label={t("@connect.settings.workspaces.removeAccessible", { workspace: workspace.name })}
                      size="sm"
                      onClick={() => setRemovalTarget(workspace)}
                    >
                      {t("@connect.settings.workspaces.remove")}
                    </Button>
                  )
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
              title={t("@connect.settings.workspaces.directoryDialog.title")}
              subtitle={t("@connect.settings.workspaces.directoryDialog.description")}
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
        title={t("@connect.settings.workspaces.removeConfirm.title", { workspace: removalTarget?.name ?? "" })}
        description={t("@connect.settings.workspaces.removeConfirm.description", {
          workspace: removalTarget?.name ?? "",
          path: removalTarget?.rootPath ?? "",
        })}
        actionLabel={t(
          remove.isPending
            ? "@connect.settings.workspaces.removeConfirm.removing"
            : "@connect.settings.workspaces.removeConfirm.action",
        )}
        cancelLabel={t("@connect.settings.workspaces.removeConfirm.cancel")}
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

import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { CheckboxInput } from "@astryxdesign/core/CheckboxInput";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { FileInput } from "@astryxdesign/core/FileInput";
import { FormLayout } from "@astryxdesign/core/FormLayout";
import { Heading } from "@astryxdesign/core/Heading";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { Section } from "@astryxdesign/core/Section";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { TextArea } from "@astryxdesign/core/TextArea";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ValidateFunction } from "ajv";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import {
  type AvailablePluginView,
  type ConfigurePluginRequest,
  type InstalledPluginView,
  MAX_PLUGIN_BUNDLE_BYTES,
  type PluginCapabilityView,
  type PluginDiagnosticStage,
  type PluginJsonSchemaView,
  type PluginSourceView,
} from "../../../../src/client-contract";
import {
  clientKeys,
  configurePlugin,
  installOfficialPlugins,
  installPlugin,
  pluginAdministrationQueryOptions,
  reinstallPlugin,
  removePlugin,
  selectPluginVersion,
  setPluginEnabled,
  updatePlugin,
  uploadPlugin,
} from "../../client-interface/query-options";
import { localizedClientError, useClientTranslator } from "../../i18n/client-i18n";

type PluginAction =
  | { type: "update" | "reinstall" | "enable" | "disable"; pluginId: string }
  | { type: "select"; pluginId: string; version: string; integrity: string }
  | { type: "remove"; pluginId: string; force: boolean }
  | { type: "official-install"; pluginId: string };

const PLUGIN_STATUS_MESSAGE = {
  active: "@connect.settings.plugins.status.active",
  disabled: "@connect.settings.plugins.status.disabled",
  error: "@connect.settings.plugins.status.error",
  available: "@connect.settings.plugins.status.available",
  unavailable: "@connect.settings.plugins.status.unavailable",
} as const;

const PLUGIN_UPDATE_MESSAGE = {
  current: "@connect.settings.plugins.update.current",
  available: "@connect.settings.plugins.update.available",
  "check-failed": "@connect.settings.plugins.update.check-failed",
  "not-installed": "@connect.settings.plugins.update.not-installed",
} as const;

const PLUGIN_DIAGNOSTIC_MESSAGE = {
  import: "@connect.settings.plugins.diagnostic.import",
  validation: "@connect.settings.plugins.diagnostic.validation",
  activation: "@connect.settings.plugins.diagnostic.activation",
  provider: "@connect.settings.plugins.diagnostic.provider",
  probe: "@connect.settings.plugins.diagnostic.probe",
  update: "@connect.settings.plugins.diagnostic.update",
} as const;

const jsonSchemaValidators = new WeakMap<object, ValidateFunction>();
const STRUCTURED_ROOT_SCHEMA_KEYS: Readonly<Record<string, true>> = {
  $anchor: true,
  $comment: true,
  $defs: true,
  $id: true,
  $schema: true,
  additionalProperties: true,
  default: true,
  definitions: true,
  deprecated: true,
  description: true,
  examples: true,
  properties: true,
  readOnly: true,
  required: true,
  title: true,
  type: true,
  writeOnly: true,
};

export function PluginSettings() {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const plugins = useQuery(pluginAdministrationQueryOptions);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [configurationTarget, setConfigurationTarget] = useState<InstalledPluginView | null>(null);
  const [removalTarget, setRemovalTarget] = useState<InstalledPluginView | null>(null);
  const [menuPluginId, setMenuPluginId] = useState<string | null>(null);
  const action = useMutation({
    mutationFn: async (input: PluginAction) => {
      switch (input.type) {
        case "update":
          return await updatePlugin(input.pluginId);
        case "reinstall":
          return await reinstallPlugin(input.pluginId);
        case "enable":
          return await setPluginEnabled(input.pluginId, true);
        case "disable":
          return await setPluginEnabled(input.pluginId, false);
        case "select":
          return await selectPluginVersion(input.pluginId, {
            version: input.version,
            integrity: input.integrity,
          });
        case "official-install":
          return await installOfficialPlugins([input.pluginId]);
        case "remove":
          return await removePlugin(input.pluginId, input.force);
      }
    },
    onSuccess: () => {
      setRemovalTarget(null);
      void queryClient.invalidateQueries({ queryKey: clientKeys.plugins });
      void queryClient.invalidateQueries({ queryKey: clientKeys.bootstrap });
    },
  });
  return (
    <Section variant="muted">
      <VStack gap={4}>
        <HStack gap={4} hAlign="between" align="start" wrap="wrap" as="header">
          <VStack gap={1}>
            <Heading level={2}>{t("@connect.settings.plugins.title")}</Heading>
            <Text type="supporting">{t("@connect.settings.plugins.description")}</Text>
          </VStack>
          <HStack gap={2} wrap="wrap">
            <Button
              label={t("@connect.settings.plugins.installReference.action")}
              variant="secondary"
              onClick={() => setReferenceOpen(true)}
            />
            <Button
              label={t("@connect.settings.plugins.upload.action")}
              variant="primary"
              onClick={() => setUploadOpen(true)}
            />
          </HStack>
        </HStack>
        {plugins.isPending ? <Spinner label={t("@connect.settings.plugins.loading")} /> : null}
        {plugins.isError ? (
          <Banner
            status="error"
            title={t("@connect.settings.plugins.loadFailed")}
            description={localizedClientError(t, plugins.error)}
            container="section"
          />
        ) : null}
        {action.isError ? (
          <Banner
            status="error"
            title={t("@connect.settings.plugins.actionFailed")}
            description={localizedClientError(t, action.error)}
            container="section"
            isDismissable
            onDismiss={() => action.reset()}
          />
        ) : null}
        {plugins.data?.diagnostics.map((diagnostic) => (
          <DiagnosticBanner
            key={`${diagnostic.stage}:${diagnostic.message}`}
            stage={diagnostic.stage}
            message={diagnostic.message}
          />
        ))}
        {plugins.data ? (
          <List
            density="compact"
            hasDividers
            header={<Text type="label">{t("@connect.settings.plugins.installed")}</Text>}
          >
            {plugins.data.installed.length === 0 ? (
              <ListItem label={t("@connect.settings.plugins.installedEmpty")} isDisabled />
            ) : null}
            {plugins.data.installed.map((plugin) => (
              <ListItem
                key={plugin.pluginId}
                label={plugin.name}
                description={<PluginRowDetails plugin={plugin} />}
                endContent={
                  <HStack gap={2} wrap="wrap">
                    <Button
                      label={t("@connect.settings.plugins.configure.action")}
                      size="sm"
                      variant="secondary"
                      onClick={() => setConfigurationTarget(plugin)}
                    />
                    <DropdownMenu
                      isMenuOpen={menuPluginId === plugin.pluginId}
                      onOpenChange={(open) => setMenuPluginId(open ? plugin.pluginId : null)}
                      button={{
                        label: t("@connect.settings.plugins.actions"),
                        size: "sm",
                        variant: "ghost",
                        isLoading: action.isPending,
                      }}
                      items={[
                        {
                          label: t("@connect.settings.plugins.update.action"),
                          onClick: () => {
                            setMenuPluginId(null);
                            action.mutate({ type: "update", pluginId: plugin.pluginId });
                          },
                        },
                        {
                          label: t("@connect.settings.plugins.reinstall.action"),
                          onClick: () => {
                            setMenuPluginId(null);
                            action.mutate({ type: "reinstall", pluginId: plugin.pluginId });
                          },
                        },
                        {
                          label: t(
                            plugin.status === "active"
                              ? "@connect.settings.plugins.disable.action"
                              : "@connect.settings.plugins.enable.action",
                          ),
                          onClick: () => {
                            setMenuPluginId(null);
                            action.mutate({
                              type: plugin.status === "active" ? "disable" : "enable",
                              pluginId: plugin.pluginId,
                            });
                          },
                        },
                        ...plugin.retainedVersions.map((retained) => ({
                          label: t("@connect.settings.plugins.select.action", { version: retained.version }),
                          onClick: () => {
                            setMenuPluginId(null);
                            action.mutate({
                              type: "select",
                              pluginId: plugin.pluginId,
                              version: retained.version,
                              integrity: retained.integrity,
                            });
                          },
                        })),
                        { type: "divider" as const },
                        {
                          label: t("@connect.settings.plugins.remove.action"),
                          onClick: () => {
                            setMenuPluginId(null);
                            setRemovalTarget(plugin);
                          },
                        },
                      ]}
                    />
                  </HStack>
                }
              />
            ))}
          </List>
        ) : null}
        {plugins.data ? (
          <List
            density="compact"
            hasDividers
            header={<Text type="label">{t("@connect.settings.plugins.available")}</Text>}
          >
            {plugins.data.available.length === 0 ? (
              <ListItem label={t("@connect.settings.plugins.availableEmpty")} isDisabled />
            ) : null}
            {plugins.data.available.map((plugin) => {
              const alreadyInstalled = plugins.data.installed.some((entry) => entry.pluginId === plugin.pluginId);
              return (
                <ListItem
                  key={plugin.pluginId}
                  label={plugin.name}
                  description={<PluginRowDetails plugin={plugin} />}
                  endContent={
                    <Button
                      label={t(
                        alreadyInstalled
                          ? "@connect.settings.plugins.official.installed"
                          : "@connect.settings.plugins.official.install",
                      )}
                      size="sm"
                      variant="secondary"
                      isDisabled={alreadyInstalled || plugin.status === "unavailable"}
                      isLoading={
                        action.isPending &&
                        action.variables?.type === "official-install" &&
                        action.variables.pluginId === plugin.pluginId
                      }
                      onClick={() => action.mutate({ type: "official-install", pluginId: plugin.pluginId })}
                    />
                  }
                />
              );
            })}
          </List>
        ) : null}
      </VStack>
      <ReferenceInstallDialog isOpen={referenceOpen} onOpenChange={setReferenceOpen} />
      <UploadInstallDialog isOpen={uploadOpen} onOpenChange={setUploadOpen} />
      <PluginConfigurationDialog
        plugin={configurationTarget}
        onOpenChange={(open) => !open && setConfigurationTarget(null)}
      />
      <AlertDialog
        isOpen={Boolean(removalTarget)}
        onOpenChange={(open) => !open && !action.isPending && setRemovalTarget(null)}
        title={t("@connect.settings.plugins.remove.title", { plugin: removalTarget?.pluginId ?? "" })}
        description={t(
          removalTarget?.dependentBindings.length
            ? "@connect.settings.plugins.remove.forceDescription"
            : "@connect.settings.plugins.remove.description",
          {
            plugin: removalTarget?.pluginId ?? "",
            bindings: removalTarget?.dependentBindings.map((binding) => binding.displayName).join(", ") ?? "",
          },
        )}
        actionLabel={t("@connect.settings.plugins.remove.confirm")}
        cancelLabel={t("@connect.settings.plugins.cancel")}
        actionVariant="destructive"
        isActionLoading={action.isPending}
        onAction={() => {
          if (removalTarget) {
            action.mutate({
              type: "remove",
              pluginId: removalTarget.pluginId,
              force: removalTarget.dependentBindings.length > 0,
            });
          }
        }}
      />
    </Section>
  );
}

function PluginRowDetails({ plugin }: { plugin: InstalledPluginView | AvailablePluginView }) {
  const t = useClientTranslator();
  const statusLabel = t(PLUGIN_STATUS_MESSAGE[plugin.status]);
  const updateLabel = t(PLUGIN_UPDATE_MESSAGE[plugin.updateAvailability.status]);
  return (
    <VStack gap={1}>
      <HStack gap={1} align="center" wrap="wrap">
        <StatusDot
          variant={
            plugin.status === "active" || plugin.status === "available"
              ? "success"
              : plugin.status === "disabled"
                ? "neutral"
                : "error"
          }
          label={statusLabel}
        />
        <Text type="supporting">{statusLabel}</Text>
        <Text type="code">{plugin.pluginId}</Text>
      </HStack>
      <MetadataLine label={t("@connect.settings.plugins.source")} value={formatPluginSource(plugin)} />
      <MetadataLine
        label={t("@connect.settings.plugins.version")}
        value={plugin.version ?? t("@connect.settings.plugins.unknown")}
      />
      <MetadataLine
        label={t("@connect.settings.plugins.capabilities")}
        value={
          plugin.capabilities.map((capability) => `${capability.type}:${capability.id}`).join(", ") ||
          t("@connect.settings.plugins.none")
        }
      />
      <MetadataLine
        label={t("@connect.settings.plugins.integrity")}
        value={plugin.integrity ?? t("@connect.settings.plugins.unknown")}
      />
      <MetadataLine
        label={t("@connect.settings.plugins.dependents")}
        value={
          plugin.dependentBindings.map((binding) => binding.displayName).join(", ") ||
          t("@connect.settings.plugins.none")
        }
      />
      <MetadataLine
        label={t("@connect.settings.plugins.updateAvailability")}
        value={plugin.updateAvailability.version ? `${updateLabel}: ${plugin.updateAvailability.version}` : updateLabel}
      />
      {plugin.kind === "installed" ? (
        <MetadataLine
          label={t("@connect.settings.plugins.retained")}
          value={
            plugin.retainedVersions.map((retained) => retained.version).join(", ") ||
            t("@connect.settings.plugins.none")
          }
        />
      ) : (
        <Banner
          status="warning"
          title={t("@connect.settings.plugins.trust.title")}
          description={t("@connect.settings.plugins.trust.description")}
          container="section"
        />
      )}
      {plugin.diagnostics.map((diagnostic) => (
        <DiagnosticBanner
          key={`${diagnostic.stage}:${diagnostic.message}`}
          stage={diagnostic.stage}
          message={diagnostic.message}
        />
      ))}
    </VStack>
  );
}

function MetadataLine({ label, value }: { label: string; value: string }) {
  return (
    <HStack gap={1} wrap="wrap">
      <Text type="label">{label}</Text>
      <Text type="code" wordBreak="break-all">
        {value}
      </Text>
    </HStack>
  );
}

function DiagnosticBanner({ stage, message }: { stage: PluginDiagnosticStage; message: string }) {
  const t = useClientTranslator();
  return (
    <Banner
      status="error"
      title={t("@connect.settings.plugins.diagnostic", { stage: t(PLUGIN_DIAGNOSTIC_MESSAGE[stage]) })}
      description={message}
      container="section"
    />
  );
}

function ReferenceInstallDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [source, setSource] = useState("");
  const [installationConfiguration, setInstallationConfiguration] = useState<Record<string, unknown>>({});
  const [exposureConfigurations, setExposureConfigurations] = useState<Record<string, Record<string, unknown>>>({});
  const [installationValid, setInstallationValid] = useState(true);
  const [capabilityValid, setCapabilityValid] = useState(true);
  const install = useMutation({
    mutationFn: async () => await installPlugin({ source, installationConfiguration, exposureConfigurations }),
    onSuccess: () => {
      onOpenChange(false);
      setSource("");
      setInstallationConfiguration({});
      setExposureConfigurations({});
      void queryClient.invalidateQueries({ queryKey: clientKeys.plugins });
    },
  });
  return (
    <PluginDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t("@connect.settings.plugins.installReference.title")}
      subtitle={t("@connect.settings.plugins.installReference.description")}
      footer={
        <HStack gap={2} hAlign="end">
          <Button
            label={t("@connect.settings.plugins.cancel")}
            variant="secondary"
            onClick={() => onOpenChange(false)}
          />
          <Button
            label={t("@connect.settings.plugins.install")}
            variant="primary"
            isLoading={install.isPending}
            isDisabled={!source.trim() || !installationValid || !capabilityValid}
            onClick={() => install.mutate()}
          />
        </HStack>
      }
    >
      <FormLayout>
        <Banner
          status="warning"
          title={t("@connect.settings.plugins.trust.title")}
          description={t("@connect.settings.plugins.trust.description")}
          container="section"
        />
        {install.isError ? (
          <Banner
            status="error"
            title={t("@connect.settings.plugins.installFailed")}
            description={localizedClientError(t, install.error)}
          />
        ) : null}
        <TextInput
          label={t("@connect.settings.plugins.installReference.source")}
          description={t("@connect.settings.plugins.installReference.sourceDescription")}
          value={source}
          onChange={setSource}
          width="100%"
          isRequired
        />
        <JsonObjectInput
          label={t("@connect.settings.plugins.installationConfiguration")}
          value={installationConfiguration}
          onChange={setInstallationConfiguration}
          onValidityChange={setInstallationValid}
        />
        <JsonObjectInput
          label={t("@connect.settings.plugins.capabilityConfigurations")}
          value={exposureConfigurations}
          onChange={(value) => setExposureConfigurations(value as Record<string, Record<string, unknown>>)}
          onValidityChange={setCapabilityValid}
        />
      </FormLayout>
    </PluginDialog>
  );
}

function UploadInstallDialog({ isOpen, onOpenChange }: { isOpen: boolean; onOpenChange: (open: boolean) => void }) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [bundle, setBundle] = useState<File | null>(null);
  const [installationConfiguration, setInstallationConfiguration] = useState<Record<string, unknown>>({});
  const [exposureConfigurations, setExposureConfigurations] = useState<Record<string, Record<string, unknown>>>({});
  const [installationValid, setInstallationValid] = useState(true);
  const [capabilityValid, setCapabilityValid] = useState(true);
  const install = useMutation({
    mutationFn: async () => {
      if (!bundle) throw new Error(t("@connect.settings.plugins.upload.required"));
      await uploadPlugin(bundle, installationConfiguration, exposureConfigurations);
    },
    onSuccess: () => {
      onOpenChange(false);
      setBundle(null);
      setInstallationConfiguration({});
      setExposureConfigurations({});
      void queryClient.invalidateQueries({ queryKey: clientKeys.plugins });
    },
  });
  return (
    <PluginDialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t("@connect.settings.plugins.upload.title")}
      subtitle={t("@connect.settings.plugins.upload.description")}
      footer={
        <HStack gap={2} hAlign="end">
          <Button
            label={t("@connect.settings.plugins.cancel")}
            variant="secondary"
            onClick={() => onOpenChange(false)}
          />
          <Button
            label={t("@connect.settings.plugins.install")}
            variant="primary"
            isLoading={install.isPending}
            isDisabled={!bundle || !installationValid || !capabilityValid}
            onClick={() => install.mutate()}
          />
        </HStack>
      }
    >
      <FormLayout>
        <Banner
          status="warning"
          title={t("@connect.settings.plugins.trust.title")}
          description={t("@connect.settings.plugins.trust.description")}
          container="section"
        />
        {install.isError ? (
          <Banner
            status="error"
            title={t("@connect.settings.plugins.installFailed")}
            description={localizedClientError(t, install.error)}
          />
        ) : null}
        <FileInput
          label={t("@connect.settings.plugins.upload.file")}
          description={t("@connect.settings.plugins.upload.fileDescription")}
          value={bundle}
          onChange={(file) => setBundle(file as File | null)}
          accept=".connect-plugin"
          maxSize={MAX_PLUGIN_BUNDLE_BYTES}
          mode="dropzone"
          isRequired
        />
        <JsonObjectInput
          label={t("@connect.settings.plugins.installationConfiguration")}
          value={installationConfiguration}
          onChange={setInstallationConfiguration}
          onValidityChange={setInstallationValid}
        />
        <JsonObjectInput
          label={t("@connect.settings.plugins.capabilityConfigurations")}
          value={exposureConfigurations}
          onChange={(value) => setExposureConfigurations(value as Record<string, Record<string, unknown>>)}
          onValidityChange={setCapabilityValid}
        />
      </FormLayout>
    </PluginDialog>
  );
}

function PluginConfigurationDialog({
  plugin,
  onOpenChange,
}: {
  plugin: InstalledPluginView | null;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [installation, setInstallation] = useState<Record<string, unknown>>({});
  const [capabilityInstances, setCapabilityInstances] = useState<Record<string, Record<string, unknown>>>({});
  const [invalidConfigurationFields, setInvalidConfigurationFields] = useState<Set<string>>(new Set());
  const [initializedPlugin, setInitializedPlugin] = useState<InstalledPluginView | null>(null);
  useEffect(() => {
    if (!plugin) {
      setInitializedPlugin(null);
      return;
    }
    const initial = createPluginConfigurationForm(plugin);
    setInstallation(initial.installation);
    setCapabilityInstances(initial.capabilityInstances);
    setInvalidConfigurationFields(initial.invalidFieldIds);
    setInitializedPlugin(plugin);
  }, [plugin]);
  const setFieldValidity = useCallback((fieldId: string, valid: boolean) => {
    setInvalidConfigurationFields((current) => {
      const isInvalid = current.has(fieldId);
      if (isInvalid === !valid) return current;
      const next = new Set(current);
      if (valid) next.delete(fieldId);
      else next.add(fieldId);
      return next;
    });
  }, []);
  const save = useMutation({
    mutationFn: async () => {
      if (!plugin) return;
      const request = pluginConfigurationRequest(plugin, installation, capabilityInstances);
      await configurePlugin(plugin.pluginId, request);
    },
    onSuccess: () => {
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: clientKeys.plugins });
    },
  });
  const configurationIsValid =
    plugin !== null && isPluginConfigurationFormValid(plugin, installation, capabilityInstances);
  return (
    <PluginDialog
      isOpen={Boolean(plugin)}
      onOpenChange={onOpenChange}
      title={t("@connect.settings.plugins.configure.title", { plugin: plugin?.pluginId ?? "" })}
      subtitle={t("@connect.settings.plugins.configure.description")}
      footer={
        <HStack gap={2} hAlign="end">
          <Button
            label={t("@connect.settings.plugins.cancel")}
            variant="secondary"
            onClick={() => onOpenChange(false)}
          />
          <Button
            label={t("@connect.settings.plugins.configure.save")}
            variant="primary"
            isLoading={save.isPending}
            isDisabled={initializedPlugin !== plugin || invalidConfigurationFields.size > 0 || !configurationIsValid}
            onClick={() => save.mutate()}
          />
        </HStack>
      }
    >
      {plugin ? (
        <FormLayout>
          {save.isError ? (
            <Banner
              status="error"
              title={t("@connect.settings.plugins.configure.failed")}
              description={localizedClientError(t, save.error)}
            />
          ) : null}
          <VStack gap={2}>
            <Heading level={3}>{t("@connect.settings.plugins.installationConfiguration")}</Heading>
            <JsonSchemaForm
              schema={plugin.installationConfigurationSchema}
              value={installation}
              onChange={setInstallation}
              prefix={`${plugin.pluginId}-installation`}
              fallbackLabel={t("@connect.settings.plugins.installationConfiguration")}
              onValidityChange={setFieldValidity}
            />
          </VStack>
          {plugin.capabilities.map((capability) => (
            <CapabilityConfiguration
              key={capability.id}
              pluginId={plugin.pluginId}
              capability={capability}
              configurations={capabilityInstances}
              onChange={(instanceKey, configuration) =>
                setCapabilityInstances((current) => ({ ...current, [instanceKey]: configuration }))
              }
              onValidityChange={setFieldValidity}
            />
          ))}
        </FormLayout>
      ) : null}
    </PluginDialog>
  );
}

function CapabilityConfiguration({
  pluginId,
  capability,
  configurations,
  onChange,
  onValidityChange,
}: {
  pluginId: string;
  capability: PluginCapabilityView;
  configurations: Record<string, Record<string, unknown>>;
  onChange: (instanceKey: string, configuration: Record<string, unknown>) => void;
  onValidityChange: (fieldId: string, valid: boolean) => void;
}) {
  const t = useClientTranslator();
  return (
    <VStack gap={2}>
      <Heading level={3}>{t("@connect.settings.plugins.capability.title", { capability: capability.id })}</Heading>
      <Text type="supporting">
        {t("@connect.settings.plugins.capability.description", {
          type: capability.type,
          family: capability.family ?? t("@connect.settings.plugins.none"),
        })}
      </Text>
      {capability.instances.length === 0 ? (
        <Text type="supporting">{t("@connect.settings.plugins.capability.noInstances")}</Text>
      ) : null}
      {capability.instances.map((instance) => {
        const instanceKey = capabilityInstanceKey(capability, instance.instanceId);
        return (
          <VStack key={instance.instanceId} gap={1}>
            <Text type="label">{instance.displayName}</Text>
            <JsonSchemaForm
              schema={capability.configurationSchema}
              value={configurations[instanceKey] ?? {}}
              onChange={(configuration) => onChange(instanceKey, configuration)}
              prefix={`${pluginId}-${capability.id}-${instance.instanceId}`}
              fallbackLabel={instance.displayName}
              onValidityChange={onValidityChange}
            />
          </VStack>
        );
      })}
    </VStack>
  );
}

function JsonSchemaForm({
  schema,
  value,
  onChange,
  prefix,
  fallbackLabel,
  onValidityChange,
}: {
  schema: PluginJsonSchemaView;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  prefix: string;
  fallbackLabel: string;
  onValidityChange?: (fieldId: string, valid: boolean) => void;
}) {
  const schemaFieldId = `${prefix}-schema`;
  const isValid = isPluginConfigurationValid(schema, value);
  useEffect(() => onValidityChange?.(schemaFieldId, isValid), [schemaFieldId, isValid, onValidityChange]);
  const properties = directJsonSchemaProperties(schema);
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((entry): entry is string => typeof entry === "string"))
    : new Set<string>();
  if (!usesStructuredJsonSchemaForm(schema)) {
    return (
      <JsonValueInput
        label={fallbackLabel}
        description={typeof schema.description === "string" ? schema.description : undefined}
        schema={schema}
        value={value}
        isRequired
        onChange={(next) => {
          if (isRecord(next)) onChange(next);
        }}
        onValidityChange={(valid) => onValidityChange?.(schemaFieldId, valid)}
        validateValue={(next) => isPluginConfigurationValid(schema, next)}
      />
    );
  }
  return (
    <FormLayout>
      {properties.map(([name, property]) => (
        <JsonSchemaField
          key={name}
          fieldId={`${prefix}-${name}`}
          name={name}
          schema={property}
          value={value[name]}
          isRequired={required.has(name)}
          onChange={(next) => {
            if (next !== undefined) {
              onChange({ ...value, [name]: next });
              return;
            }
            const remaining = { ...value };
            delete remaining[name];
            onChange(remaining);
          }}
          onValidityChange={onValidityChange}
        />
      ))}
    </FormLayout>
  );
}

function JsonSchemaField({
  fieldId,
  name,
  schema,
  value,
  isRequired,
  onChange,
  onValidityChange,
}: {
  fieldId: string;
  name: string;
  schema: Record<string, unknown>;
  value: unknown;
  isRequired: boolean;
  onChange: (value: unknown) => void;
  onValidityChange?: (fieldId: string, valid: boolean) => void;
}) {
  const label = typeof schema.title === "string" ? schema.title : name;
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const isValid = isJsonSchemaFieldValid(schema, value, isRequired);
  useEffect(() => onValidityChange?.(fieldId, isValid), [fieldId, isValid, onValidityChange]);
  if (schema.type === "boolean") {
    return (
      <CheckboxInput
        label={label}
        description={description}
        value={value === undefined && isRequired ? "indeterminate" : value === true}
        onChange={onChange}
        isRequired={isRequired}
      />
    );
  }
  const enumValues = schema.enum;
  if (Array.isArray(enumValues)) {
    const selectedIndex = enumValues.findIndex((option) => Object.is(option, value));
    return (
      <Selector
        label={label}
        description={description}
        options={enumValues.map((option, index) => ({ value: String(index), label: String(option) }))}
        value={selectedIndex < 0 ? undefined : String(selectedIndex)}
        onChange={(index) => onChange(enumValues[Number(index)])}
        isRequired={isRequired}
        width="100%"
      />
    );
  }
  if (schema.type === "string") {
    return (
      <TextInput
        label={label}
        description={description}
        value={typeof value === "string" ? value : ""}
        onChange={(next) => onChange(next === "" && !isRequired ? undefined : next)}
        isRequired={isRequired}
        width="100%"
      />
    );
  }
  return (
    <JsonValueInput
      label={label}
      description={description}
      schema={schema}
      value={value}
      isRequired={isRequired}
      onChange={onChange}
      onValidityChange={(valid) => onValidityChange?.(fieldId, valid)}
    />
  );
}

function JsonValueInput({
  label,
  description,
  schema,
  value,
  isRequired,
  onChange,
  onValidityChange,
  validateValue,
}: {
  label: string;
  description?: string;
  schema: Record<string, unknown>;
  value: unknown;
  isRequired: boolean;
  onChange: (value: unknown) => void;
  onValidityChange: (valid: boolean) => void;
  validateValue?: (value: unknown) => boolean;
}) {
  const t = useClientTranslator();
  const [raw, setRaw] = useState(value === undefined ? "" : (JSON.stringify(value, null, 2) ?? ""));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setRaw(value === undefined ? "" : (JSON.stringify(value, null, 2) ?? "")), [value]);
  const isValueValid = validateValue ?? ((candidate: unknown) => isJsonSchemaFieldValid(schema, candidate, isRequired));
  return (
    <TextArea
      label={label}
      description={description ?? t("@connect.settings.plugins.schema.jsonDescription")}
      value={raw}
      onChange={(next) => {
        setRaw(next);
        if (next.trim() === "") {
          if (!isRequired) {
            onChange(undefined);
            setError(null);
            onValidityChange(true);
            return;
          }
          setError(t("@connect.settings.plugins.schema.invalidJson"));
          onValidityChange(false);
          return;
        }
        try {
          const parsed = JSON.parse(next) as unknown;
          if (!isValueValid(parsed)) {
            setError(t("@connect.settings.plugins.schema.invalidJson"));
            onValidityChange(false);
            return;
          }
          onChange(parsed);
          setError(null);
          onValidityChange(true);
        } catch {
          setError(t("@connect.settings.plugins.schema.invalidJson"));
          onValidityChange(false);
        }
      }}
      isRequired={isRequired}
      status={error ? { type: "error", message: error } : undefined}
      statusVariant="detached"
      hasSpellCheck={false}
      width="100%"
    />
  );
}

function JsonObjectInput({
  label,
  value,
  onChange,
  onValidityChange,
}: {
  label: string;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  onValidityChange: (valid: boolean) => void;
}) {
  const t = useClientTranslator();
  const [raw, setRaw] = useState(JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setRaw(JSON.stringify(value, null, 2));
    setError(null);
    onValidityChange(true);
  }, [value, onValidityChange]);
  return (
    <TextArea
      label={label}
      description={t("@connect.settings.plugins.schema.objectDescription")}
      value={raw}
      onChange={(next) => {
        setRaw(next);
        try {
          const parsed = JSON.parse(next) as unknown;
          if (!isRecord(parsed)) throw new Error("object required");
          onChange(parsed);
          setError(null);
          onValidityChange(true);
        } catch {
          setError(t("@connect.settings.plugins.schema.invalidObject"));
          onValidityChange(false);
        }
      }}
      status={error ? { type: "error", message: error } : undefined}
      statusVariant="detached"
      hasSpellCheck={false}
      width="100%"
    />
  );
}

function PluginDialog({
  isOpen,
  onOpenChange,
  title,
  subtitle,
  footer,
  children,
}: {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  subtitle: string;
  footer: ReactNode;
  children: ReactNode;
}) {
  return (
    <Dialog
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      purpose="form"
      width={720}
      maxHeight="calc(100dvh - var(--spacing-6))"
    >
      <Layout
        header={<DialogHeader title={title} subtitle={subtitle} onOpenChange={onOpenChange} />}
        content={<LayoutContent padding={4}>{children}</LayoutContent>}
        footer={<LayoutFooter hasDivider>{footer}</LayoutFooter>}
      />
    </Dialog>
  );
}

function formatPluginSource(plugin: InstalledPluginView | AvailablePluginView): string {
  if (plugin.kind === "available" && !plugin.source) return plugin.sourceReference;
  const source = plugin.source as PluginSourceView;
  if (source.type === "local") return `local:${source.path}`;
  if (source.type === "npm") return `npm:${source.package}@${source.version}`;
  return `github:${source.repository}@${source.release}`;
}

export function createPluginConfigurationForm(plugin: InstalledPluginView): {
  installation: Record<string, unknown>;
  capabilityInstances: Record<string, Record<string, unknown>>;
  invalidFieldIds: Set<string>;
} {
  const invalidFieldIds = new Set<string>();
  const installation = prepareJsonSchemaConfiguration(
    plugin.installationConfigurationSchema,
    plugin.installationConfiguration,
    `${plugin.pluginId}-installation`,
    invalidFieldIds,
  );
  const capabilityInstances = Object.fromEntries(
    plugin.capabilities.flatMap((capability) =>
      capability.instances.map((instance) => {
        const instanceKey = capabilityInstanceKey(capability, instance.instanceId);
        return [
          instanceKey,
          prepareJsonSchemaConfiguration(
            capability.configurationSchema,
            instance.configuration,
            `${plugin.pluginId}-${capability.id}-${instance.instanceId}`,
            invalidFieldIds,
          ),
        ];
      }),
    ),
  );
  return { installation, capabilityInstances, invalidFieldIds };
}

export function isPluginConfigurationFormValid(
  plugin: InstalledPluginView,
  installation: Record<string, unknown>,
  capabilityInstances: Record<string, Record<string, unknown>>,
): boolean {
  if (!isPluginConfigurationValid(plugin.installationConfigurationSchema, installation)) return false;
  return plugin.capabilities.every((capability) =>
    capability.instances.every((instance) =>
      isPluginConfigurationValid(
        capability.configurationSchema,
        capabilityInstances[capabilityInstanceKey(capability, instance.instanceId)] ?? {},
      ),
    ),
  );
}

export function pluginConfigurationRequest(
  plugin: InstalledPluginView,
  installation: Record<string, unknown>,
  capabilityInstances: Record<string, Record<string, unknown>>,
): ConfigurePluginRequest {
  const runtimeConfigurations: Record<string, Record<string, unknown>> = {};
  const exposureConfigurations: Record<string, Record<string, unknown>> = {};
  for (const capability of plugin.capabilities) {
    for (const instance of capability.instances) {
      const configuration = capabilityInstances[capabilityInstanceKey(capability, instance.instanceId)] ?? {};
      if (capability.type === "runtime" && instance.bindingId)
        runtimeConfigurations[instance.bindingId] = configuration;
      if (capability.type === "exposure") exposureConfigurations[capability.id] = configuration;
    }
  }
  return { installationConfiguration: installation, exposureConfigurations, runtimeConfigurations };
}

function prepareJsonSchemaConfiguration(
  schema: PluginJsonSchemaView,
  configuration: Record<string, unknown>,
  prefix: string,
  invalidFieldIds: Set<string>,
): Record<string, unknown> {
  const prepared = structuredClone(configuration);
  const required = Array.isArray(schema.required)
    ? new Set(schema.required.filter((entry): entry is string => typeof entry === "string"))
    : new Set<string>();
  for (const [name, property] of directJsonSchemaProperties(schema)) {
    let fieldValue = prepared[name];
    if (fieldValue === undefined && property.default !== undefined) {
      fieldValue = structuredClone(property.default);
      prepared[name] = fieldValue;
    }
    if (!isJsonSchemaFieldValid(property, fieldValue, required.has(name))) {
      invalidFieldIds.add(`${prefix}-${name}`);
    }
  }
  if (!isPluginConfigurationValid(schema, prepared)) invalidFieldIds.add(`${prefix}-schema`);
  return prepared;
}

export function directJsonSchemaProperties(schema: PluginJsonSchemaView): Array<[string, Record<string, unknown>]> {
  if (!isRecord(schema.properties)) return [];
  return Object.entries(schema.properties).filter((entry): entry is [string, Record<string, unknown>] =>
    isRecord(entry[1]),
  );
}

export function usesStructuredJsonSchemaForm(schema: PluginJsonSchemaView): boolean {
  if (schema.additionalProperties !== false || !isRecord(schema.properties)) return false;
  const properties = directJsonSchemaProperties(schema);
  if (properties.length === 0 || properties.length !== Object.keys(schema.properties).length) return false;
  if (Object.keys(schema).some((key) => STRUCTURED_ROOT_SCHEMA_KEYS[key] !== true)) return false;
  const type = schema.type;
  if (type !== undefined && type !== "object" && !(Array.isArray(type) && type.includes("object"))) return false;
  if (!Array.isArray(schema.required)) return schema.required === undefined;
  return schema.required.every(
    (name) => typeof name === "string" && properties.some(([propertyName]) => propertyName === name),
  );
}

export function isPluginConfigurationValid(
  schema: PluginJsonSchemaView,
  value: unknown,
): value is Record<string, unknown> {
  return isRecord(value) && jsonSchemaValidator(schema)(value);
}

function jsonSchemaValidator(schema: PluginJsonSchemaView): ValidateFunction {
  const cached = jsonSchemaValidators.get(schema);
  if (cached) return cached;
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validate = ajv.compile(schema);
  jsonSchemaValidators.set(schema, validate);
  return validate;
}

function isJsonSchemaFieldValid(schema: Record<string, unknown>, value: unknown, isRequired: boolean): boolean {
  if (value === undefined) return !isRequired;
  try {
    return jsonSchemaValidator(schema)(value);
  } catch {
    // Root-relative references are validated by the complete configuration schema.
    return true;
  }
}

function capabilityInstanceKey(capability: PluginCapabilityView, instanceId: string): string {
  return `${capability.type}:${capability.id}:${instanceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

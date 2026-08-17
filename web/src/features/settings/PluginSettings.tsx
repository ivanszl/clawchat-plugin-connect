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
  discovery: "@connect.settings.plugins.diagnostic.discovery",
  import: "@connect.settings.plugins.diagnostic.import",
  validation: "@connect.settings.plugins.diagnostic.validation",
  activation: "@connect.settings.plugins.diagnostic.activation",
  provider: "@connect.settings.plugins.diagnostic.provider",
  update: "@connect.settings.plugins.diagnostic.update",
} as const;

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
  const [capabilityConfigurations, setCapabilityConfigurations] = useState<Record<string, Record<string, unknown>>>({});
  const [installationValid, setInstallationValid] = useState(true);
  const [capabilityValid, setCapabilityValid] = useState(true);
  const install = useMutation({
    mutationFn: async () => await installPlugin({ source, installationConfiguration, capabilityConfigurations }),
    onSuccess: () => {
      onOpenChange(false);
      setSource("");
      setInstallationConfiguration({});
      setCapabilityConfigurations({});
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
          value={capabilityConfigurations}
          onChange={(value) => setCapabilityConfigurations(value as Record<string, Record<string, unknown>>)}
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
  const [capabilityConfigurations, setCapabilityConfigurations] = useState<Record<string, Record<string, unknown>>>({});
  const [installationValid, setInstallationValid] = useState(true);
  const [capabilityValid, setCapabilityValid] = useState(true);
  const install = useMutation({
    mutationFn: async () => {
      if (!bundle) throw new Error(t("@connect.settings.plugins.upload.required"));
      await uploadPlugin(bundle, installationConfiguration, capabilityConfigurations);
    },
    onSuccess: () => {
      onOpenChange(false);
      setBundle(null);
      setInstallationConfiguration({});
      setCapabilityConfigurations({});
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
          value={capabilityConfigurations}
          onChange={(value) => setCapabilityConfigurations(value as Record<string, Record<string, unknown>>)}
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

export function JsonSchemaForm({
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
        rootSchema={schema}
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
          rootSchema={schema}
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
  rootSchema,
  value,
  isRequired,
  onChange,
  onValidityChange,
}: {
  fieldId: string;
  name: string;
  schema: Record<string, unknown>;
  rootSchema: PluginJsonSchemaView;
  value: unknown;
  isRequired: boolean;
  onChange: (value: unknown) => void;
  onValidityChange?: (fieldId: string, valid: boolean) => void;
}) {
  const label = typeof schema.title === "string" ? schema.title : name;
  const description = typeof schema.description === "string" ? schema.description : undefined;
  const isValid = isJsonSchemaFieldValid(schema, value, isRequired, rootSchema);
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
      rootSchema={rootSchema}
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
  rootSchema,
  value,
  isRequired,
  onChange,
  onValidityChange,
  validateValue,
}: {
  label: string;
  description?: string;
  schema: Record<string, unknown>;
  rootSchema: PluginJsonSchemaView;
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
  const isValueValid =
    validateValue ?? ((candidate: unknown) => isJsonSchemaFieldValid(schema, candidate, isRequired, rootSchema));
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
  const capabilityConfigurations: Record<string, Record<string, unknown>> = {};
  for (const capability of plugin.capabilities) {
    for (const instance of capability.instances) {
      const configuration = capabilityInstances[capabilityInstanceKey(capability, instance.instanceId)] ?? {};
      if (capability.type === "runtime" && instance.bindingId)
        runtimeConfigurations[instance.bindingId] = configuration;
      if (capability.type === "exposure" || capability.type === "client-extension")
        capabilityConfigurations[capability.id] = configuration;
    }
  }
  return { installationConfiguration: installation, capabilityConfigurations, runtimeConfigurations };
}

export function prepareJsonSchemaConfiguration(
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
    if (!isJsonSchemaFieldValid(property, fieldValue, required.has(name), schema)) {
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
  return isRecord(value) && validatesJsonSchema(schema, value, schema, 0);
}

function validatesJsonSchema(schema: unknown, value: unknown, root: PluginJsonSchemaView, depth: number): boolean {
  if (schema === true) return true;
  if (schema === false || !isRecord(schema) || depth > 100) return false;
  if (typeof schema.$ref === "string") {
    const resolved = resolveLocalJsonSchemaReference(root, schema.$ref);
    if (resolved === undefined || !validatesJsonSchema(resolved, value, root, depth + 1)) return false;
  }
  if (
    Array.isArray(schema.allOf) &&
    !schema.allOf.every((entry) => validatesJsonSchema(entry, value, root, depth + 1))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.anyOf) &&
    !schema.anyOf.some((entry) => validatesJsonSchema(entry, value, root, depth + 1))
  ) {
    return false;
  }
  if (
    Array.isArray(schema.oneOf) &&
    schema.oneOf.filter((entry) => validatesJsonSchema(entry, value, root, depth + 1)).length !== 1
  ) {
    return false;
  }
  if (schema.not !== undefined && validatesJsonSchema(schema.not, value, root, depth + 1)) return false;
  if (schema.if !== undefined && validatesJsonSchema(schema.if, value, root, depth + 1)) {
    if (schema.then !== undefined && !validatesJsonSchema(schema.then, value, root, depth + 1)) return false;
  } else if (schema.else !== undefined && !validatesJsonSchema(schema.else, value, root, depth + 1)) {
    return false;
  }
  if (schema.const !== undefined && !jsonValuesEqual(value, schema.const)) return false;
  if (Array.isArray(schema.enum) && !schema.enum.some((entry) => jsonValuesEqual(value, entry))) return false;
  if (!matchesJsonSchemaType(schema.type, value)) return false;

  if (typeof value === "number") {
    if (!Number.isFinite(value)) return false;
    if (typeof schema.minimum === "number" && value < schema.minimum) return false;
    if (typeof schema.maximum === "number" && value > schema.maximum) return false;
    if (typeof schema.exclusiveMinimum === "number" && value <= schema.exclusiveMinimum) return false;
    if (typeof schema.exclusiveMaximum === "number" && value >= schema.exclusiveMaximum) return false;
    if (
      typeof schema.multipleOf === "number" &&
      schema.multipleOf > 0 &&
      Math.abs(value / schema.multipleOf - Math.round(value / schema.multipleOf)) > Number.EPSILON * 10
    ) {
      return false;
    }
  }
  if (typeof value === "string") {
    const length = [...value].length;
    if (typeof schema.minLength === "number" && length < schema.minLength) return false;
    if (typeof schema.maxLength === "number" && length > schema.maxLength) return false;
    if (typeof schema.pattern === "string") {
      try {
        if (!new RegExp(schema.pattern, "u").test(value)) return false;
      } catch {
        return false;
      }
    }
    if (typeof schema.format === "string" && !matchesJsonSchemaFormat(schema.format, value)) return false;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === "number" && value.length < schema.minItems) return false;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return false;
    if (
      schema.uniqueItems === true &&
      value.some((entry, index) => value.slice(0, index).some((other) => jsonValuesEqual(entry, other)))
    ) {
      return false;
    }
    const prefixItems = Array.isArray(schema.prefixItems) ? schema.prefixItems : [];
    if (
      prefixItems.some(
        (itemSchema, index) => index < value.length && !validatesJsonSchema(itemSchema, value[index], root, depth + 1),
      )
    ) {
      return false;
    }
    if (schema.items !== undefined) {
      const remaining = value.slice(prefixItems.length);
      if (schema.items === false && remaining.length > 0) return false;
      if (
        schema.items !== true &&
        schema.items !== false &&
        remaining.some((entry) => !validatesJsonSchema(schema.items, entry, root, depth + 1))
      ) {
        return false;
      }
    }
    if (schema.contains !== undefined) {
      const matches = value.filter((entry) => validatesJsonSchema(schema.contains, entry, root, depth + 1)).length;
      if (matches < (typeof schema.minContains === "number" ? schema.minContains : 1)) return false;
      if (typeof schema.maxContains === "number" && matches > schema.maxContains) return false;
    }
  }
  if (isRecord(value)) {
    const entries = Object.entries(value);
    if (typeof schema.minProperties === "number" && entries.length < schema.minProperties) return false;
    if (typeof schema.maxProperties === "number" && entries.length > schema.maxProperties) return false;
    const required = Array.isArray(schema.required)
      ? schema.required.filter((entry): entry is string => typeof entry === "string")
      : [];
    if (required.some((name) => !(name in value))) return false;
    const properties = isRecord(schema.properties) ? schema.properties : {};
    for (const [name, propertySchema] of Object.entries(properties)) {
      if (name in value && !validatesJsonSchema(propertySchema, value[name], root, depth + 1)) return false;
    }
    const patternProperties = isRecord(schema.patternProperties) ? schema.patternProperties : {};
    const patterns: Array<[RegExp, unknown]> = [];
    try {
      for (const [pattern, propertySchema] of Object.entries(patternProperties)) {
        patterns.push([new RegExp(pattern, "u"), propertySchema]);
      }
    } catch {
      return false;
    }
    for (const [name, entry] of entries) {
      const matchedPatternSchemas = patterns
        .filter(([pattern]) => pattern.test(name))
        .map(([, itemSchema]) => itemSchema);
      if (matchedPatternSchemas.some((itemSchema) => !validatesJsonSchema(itemSchema, entry, root, depth + 1))) {
        return false;
      }
      if (!(name in properties) && matchedPatternSchemas.length === 0) {
        if (schema.additionalProperties === false) return false;
        if (
          schema.additionalProperties !== undefined &&
          schema.additionalProperties !== true &&
          !validatesJsonSchema(schema.additionalProperties, entry, root, depth + 1)
        ) {
          return false;
        }
      }
      if (schema.propertyNames !== undefined && !validatesJsonSchema(schema.propertyNames, name, root, depth + 1)) {
        return false;
      }
    }
    if (isRecord(schema.dependentRequired)) {
      for (const [name, dependencies] of Object.entries(schema.dependentRequired)) {
        if (
          name in value &&
          Array.isArray(dependencies) &&
          dependencies.some((dependency) => typeof dependency === "string" && !(dependency in value))
        ) {
          return false;
        }
      }
    }
    if (isRecord(schema.dependentSchemas)) {
      for (const [name, dependentSchema] of Object.entries(schema.dependentSchemas)) {
        if (name in value && !validatesJsonSchema(dependentSchema, value, root, depth + 1)) return false;
      }
    }
  }
  return true;
}

function matchesJsonSchemaType(type: unknown, value: unknown): boolean {
  if (type === undefined) return true;
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    if (candidate === "null") return value === null;
    if (candidate === "array") return Array.isArray(value);
    if (candidate === "object") return isRecord(value);
    if (candidate === "integer") return typeof value === "number" && Number.isInteger(value);
    return typeof value === candidate;
  });
}

function matchesJsonSchemaFormat(format: string, value: string): boolean {
  if (format === "email") return /^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value);
  if (format === "hostname") {
    return (
      value.length <= 253 &&
      value.split(".").every((label) => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/u.test(label))
    );
  }
  if (format === "ipv4") {
    const parts = value.split(".");
    return parts.length === 4 && parts.every((part) => /^\d{1,3}$/u.test(part) && Number(part) <= 255);
  }
  if (format === "uri" || format === "url") {
    try {
      return Boolean(new URL(value).protocol);
    } catch {
      return false;
    }
  }
  if (format === "date") return /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
  if (format === "time") return /^(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-][0-2]\d:[0-5]\d)$/u.test(value);
  if (format === "date-time") return !Number.isNaN(Date.parse(value)) && /T/u.test(value);
  return true;
}

function resolveLocalJsonSchemaReference(root: PluginJsonSchemaView, reference: string): unknown {
  if (reference === "#") return root;
  if (!reference.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawSegment of reference.slice(2).split("/")) {
    if (!isRecord(current)) return undefined;
    current = current[rawSegment.replaceAll("~1", "/").replaceAll("~0", "~")];
  }
  return current;
}

function jsonValuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) && Array.isArray(right)) {
    return left.length === right.length && left.every((entry, index) => jsonValuesEqual(entry, right[index]));
  }
  if (isRecord(left) && isRecord(right)) {
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every((key) => key in right && jsonValuesEqual(left[key], right[key]))
    );
  }
  return false;
}

function isJsonSchemaFieldValid(
  schema: Record<string, unknown>,
  value: unknown,
  isRequired: boolean,
  rootSchema: PluginJsonSchemaView,
): boolean {
  if (value === undefined) return !isRequired;
  return validatesJsonSchema(schema, value, rootSchema, 0);
}

function capabilityInstanceKey(capability: PluginCapabilityView, instanceId: string): string {
  return `${capability.type}:${capability.id}:${instanceId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

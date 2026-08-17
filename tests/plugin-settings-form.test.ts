import { describe, expect, it } from "bun:test";
import type { InstalledPluginView } from "../src/client-contract";
import {
  createPluginConfigurationForm,
  directJsonSchemaProperties,
  isPluginConfigurationFormValid,
  pluginConfigurationRequest,
  usesStructuredJsonSchemaForm,
} from "../web/src/features/settings/PluginSettings";

const plugin: InstalledPluginView = {
  kind: "installed",
  pluginId: "fixture.settings",
  name: "Settings fixture",
  source: { type: "local", path: "/fixture.connect-plugin" },
  version: "1.0.0",
  target: "fixture-target",
  integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  status: "active",
  dependentBindings: [],
  updateAvailability: {
    status: "current",
    version: "1.0.0",
    integrity: "sha256-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    diagnostic: null,
  },
  retainedVersions: [],
  installationConfigurationSchema: {
    type: "object",
    properties: {
      requiredChannel: { type: "string", enum: ["stable", "preview"] },
      requiredDiagnostics: { type: "boolean" },
      requiredLabel: { type: "string" },
      requiredPolicy: { type: "object" },
      optionalChannel: { type: "string", enum: ["stable", "preview"] },
      diagnostics: { type: "boolean", default: false },
    },
    required: ["requiredChannel", "requiredDiagnostics", "requiredLabel", "requiredPolicy"],
    additionalProperties: false,
  },
  installationConfiguration: {},
  capabilities: [
    {
      id: "runtime",
      type: "runtime",
      family: "fixture",
      configurationSchema: {
        type: "object",
        properties: { workspace: { type: "string" } },
        required: ["workspace"],
        additionalProperties: false,
      },
      instances: [
        {
          instanceId: "primary",
          bindingId: "binding-1",
          displayName: "Primary",
          configuration: { workspace: "project" },
        },
      ],
    },
  ],
  diagnostics: [],
};

function pluginWithInstallation(
  installationConfigurationSchema: InstalledPluginView["installationConfigurationSchema"],
  installationConfiguration: Record<string, unknown>,
): InstalledPluginView {
  return { ...plugin, installationConfigurationSchema, installationConfiguration };
}

describe("Plugin Settings JSON Schema form state", () => {
  it("keeps missing required fields invalid, preserves an optional unset enum, and submits the visible valid state", () => {
    const initial = createPluginConfigurationForm(plugin);
    expect(usesStructuredJsonSchemaForm(plugin.installationConfigurationSchema)).toBe(true);

    expect(initial.installation).toEqual({ diagnostics: false });
    expect(initial.installation).not.toHaveProperty("optionalChannel");
    expect([...initial.invalidFieldIds].sort()).toEqual([
      "fixture.settings-installation-requiredChannel",
      "fixture.settings-installation-requiredDiagnostics",
      "fixture.settings-installation-requiredLabel",
      "fixture.settings-installation-requiredPolicy",
      "fixture.settings-installation-schema",
    ]);
    const isInitialSaveDisabled = initial.invalidFieldIds.size > 0;
    expect(isInitialSaveDisabled).toBe(true);

    const selectedConfiguration = {
      ...initial.installation,
      requiredChannel: "stable",
      requiredDiagnostics: false,
      requiredLabel: "Fixture",
      requiredPolicy: { access: "local" },
      optionalChannel: "preview",
    };
    const selected = createPluginConfigurationForm({
      ...plugin,
      installationConfiguration: selectedConfiguration,
    });

    const isSaveDisabled = selected.invalidFieldIds.size > 0;
    expect(isSaveDisabled).toBe(false);
    expect(selected.installation.optionalChannel).toBe("preview");
    expect(pluginConfigurationRequest(plugin, selected.installation, selected.capabilityInstances)).toEqual({
      installationConfiguration: selectedConfiguration,
      capabilityConfigurations: {},
      runtimeConfigurations: { "binding-1": { workspace: "project" } },
    });
  });

  it("matches OpenCode whitespace validation and string bounds", () => {
    const schema = {
      type: "object",
      properties: {
        executablePath: { type: "string", minLength: 1, maxLength: 32, pattern: "\\S" },
      },
      required: ["executablePath"],
      additionalProperties: false,
    };
    for (const executablePath of ["", "   ", "x".repeat(33)]) {
      const candidate = pluginWithInstallation(schema, { executablePath });
      const form = createPluginConfigurationForm(candidate);
      expect(isPluginConfigurationFormValid(candidate, form.installation, form.capabilityInstances)).toBe(false);
      expect(form.invalidFieldIds.has("fixture.settings-installation-executablePath")).toBe(true);
      expect(form.invalidFieldIds.has("fixture.settings-installation-schema")).toBe(true);
    }

    const candidate = pluginWithInstallation(schema, { executablePath: " /opt/bin/opencode " });
    const form = createPluginConfigurationForm(candidate);
    expect(isPluginConfigurationFormValid(candidate, form.installation, form.capabilityInstances)).toBe(true);
    expect(form.invalidFieldIds.size).toBe(0);
  });

  it("applies nested object, array, numeric, format, enum, const, and additional-property constraints", () => {
    const schema = {
      type: "object",
      properties: {
        policy: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 2, maxLength: 12, pattern: "\\S" },
            scopes: {
              type: "array",
              minItems: 1,
              maxItems: 2,
              items: { type: "string", enum: ["read", "write"] },
            },
            retries: { type: "integer", minimum: 0, maximum: 3 },
            endpoint: { type: "string", format: "uri" },
            mode: { const: "strict" },
          },
          required: ["name", "scopes", "retries", "endpoint", "mode"],
          additionalProperties: false,
        },
      },
      required: ["policy"],
      additionalProperties: false,
    };
    const validConfiguration = {
      policy: {
        name: "Local",
        scopes: ["read", "write"],
        retries: 2,
        endpoint: "https://connect.example/plugin",
        mode: "strict",
      },
    };
    const validPlugin = pluginWithInstallation(schema, validConfiguration);
    const validForm = createPluginConfigurationForm(validPlugin);
    expect(isPluginConfigurationFormValid(validPlugin, validForm.installation, validForm.capabilityInstances)).toBe(
      true,
    );

    for (const policy of [
      {
        scopes: validConfiguration.policy.scopes,
        retries: validConfiguration.policy.retries,
        endpoint: validConfiguration.policy.endpoint,
        mode: validConfiguration.policy.mode,
      },
      { ...validConfiguration.policy, unexpected: true },
      { ...validConfiguration.policy, scopes: ["admin"] },
      { ...validConfiguration.policy, scopes: [] },
      { ...validConfiguration.policy, scopes: ["read", "write", "read"] },
      { ...validConfiguration.policy, retries: 4 },
      { ...validConfiguration.policy, retries: 1.5 },
      { ...validConfiguration.policy, endpoint: "not a URI" },
      { ...validConfiguration.policy, mode: "permissive" },
    ]) {
      const candidate = pluginWithInstallation(schema, { policy });
      const form = createPluginConfigurationForm(candidate);
      expect(isPluginConfigurationFormValid(candidate, form.installation, form.capabilityInstances)).toBe(false);
      expect(form.invalidFieldIds.has("fixture.settings-installation-policy")).toBe(true);
      expect(form.invalidFieldIds.has("fixture.settings-installation-schema")).toBe(true);
    }
  });

  it("uses the full-object editor path for schemas composed without direct properties", () => {
    const schema = {
      type: "object",
      allOf: [{ $ref: "#/$defs/configuration" }],
      $defs: {
        configuration: {
          type: "object",
          properties: { enabled: { type: "boolean" } },
          patternProperties: { "^x-": { type: "integer", minimum: 1 } },
          required: ["enabled"],
          additionalProperties: { type: "string", minLength: 1 },
        },
      },
    };
    expect(directJsonSchemaProperties(schema)).toEqual([]);
    expect(usesStructuredJsonSchemaForm(schema)).toBe(false);

    const missingRequired = pluginWithInstallation(schema, {});
    const initial = createPluginConfigurationForm(missingRequired);
    expect(isPluginConfigurationFormValid(missingRequired, initial.installation, initial.capabilityInstances)).toBe(
      false,
    );
    expect(initial.invalidFieldIds).toEqual(new Set(["fixture.settings-installation-schema"]));

    const visibleConfiguration = { enabled: false, "x-retries": 2, note: "local" };
    const edited = pluginWithInstallation(schema, visibleConfiguration);
    const editedForm = createPluginConfigurationForm(edited);
    expect(isPluginConfigurationFormValid(edited, editedForm.installation, editedForm.capabilityInstances)).toBe(true);
    expect(pluginConfigurationRequest(edited, editedForm.installation, editedForm.capabilityInstances)).toEqual({
      installationConfiguration: visibleConfiguration,
      capabilityConfigurations: {},
      runtimeConfigurations: { "binding-1": { workspace: "project" } },
    });

    const rejected = pluginWithInstallation(schema, { ...visibleConfiguration, "x-retries": 0 });
    const rejectedForm = createPluginConfigurationForm(rejected);
    expect(isPluginConfigurationFormValid(rejected, rejectedForm.installation, rejectedForm.capabilityInstances)).toBe(
      false,
    );
  });

  it("uses the full-object editor when composition requires a field absent from direct properties", () => {
    const schema = {
      type: "object",
      properties: { visible: { type: "string", minLength: 1 } },
      required: ["visible"],
      additionalProperties: true,
      allOf: [
        {
          properties: { hidden: { type: "boolean" } },
          required: ["hidden"],
        },
      ],
    };
    expect(directJsonSchemaProperties(schema).map(([name]) => name)).toEqual(["visible"]);
    expect(usesStructuredJsonSchemaForm(schema)).toBe(false);

    const missingHidden = pluginWithInstallation(schema, { visible: "shown" });
    const missingForm = createPluginConfigurationForm(missingHidden);
    expect(
      isPluginConfigurationFormValid(missingHidden, missingForm.installation, missingForm.capabilityInstances),
    ).toBe(false);

    const visibleConfiguration = { visible: "shown", hidden: false };
    const edited = pluginWithInstallation(schema, visibleConfiguration);
    const editedForm = createPluginConfigurationForm(edited);
    expect(isPluginConfigurationFormValid(edited, editedForm.installation, editedForm.capabilityInstances)).toBe(true);
    expect(pluginConfigurationRequest(edited, editedForm.installation, editedForm.capabilityInstances)).toEqual({
      installationConfiguration: visibleConfiguration,
      capabilityConfigurations: {},
      runtimeConfigurations: { "binding-1": { workspace: "project" } },
    });
  });

  it("keeps structured local-ref fields and Save enablement aligned with whole-form validation", () => {
    const schema = {
      type: "object",
      $defs: {
        policy: {
          type: "object",
          properties: {
            rules: {
              type: "array",
              minItems: 1,
              items: { $ref: "#/$defs/rule" },
            },
          },
          required: ["rules"],
          additionalProperties: false,
        },
        rule: {
          type: "object",
          properties: { action: { type: "string", enum: ["allow", "deny"] } },
          required: ["action"],
          additionalProperties: false,
        },
      },
      properties: {
        policy: { title: "Policy", $ref: "#/$defs/policy" },
      },
      required: ["policy"],
      additionalProperties: false,
    };
    expect(usesStructuredJsonSchemaForm(schema)).toBe(true);

    const validPlugin = pluginWithInstallation(schema, { policy: { rules: [{ action: "allow" }] } });
    const validForm = createPluginConfigurationForm(validPlugin);
    expect(isPluginConfigurationFormValid(validPlugin, validForm.installation, validForm.capabilityInstances)).toBe(
      true,
    );
    expect(validForm.invalidFieldIds.size > 0).toBe(false);
    expect(pluginConfigurationRequest(validPlugin, validForm.installation, validForm.capabilityInstances)).toEqual({
      installationConfiguration: { policy: { rules: [{ action: "allow" }] } },
      capabilityConfigurations: {},
      runtimeConfigurations: { "binding-1": { workspace: "project" } },
    });

    const invalidPlugin = pluginWithInstallation(schema, { policy: { rules: [{ action: "audit" }] } });
    const invalidForm = createPluginConfigurationForm(invalidPlugin);
    expect(
      isPluginConfigurationFormValid(invalidPlugin, invalidForm.installation, invalidForm.capabilityInstances),
    ).toBe(false);
    expect(invalidForm.invalidFieldIds).toEqual(
      new Set(["fixture.settings-installation-policy", "fixture.settings-installation-schema"]),
    );
    expect(invalidForm.invalidFieldIds.size > 0).toBe(true);
  });
});

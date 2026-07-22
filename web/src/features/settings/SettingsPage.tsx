import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import type { BindingPreferenceView, BootstrapView } from "../../../../src/client-contract";
import {
  bootstrapQueryOptions,
  catalogQueryOptions,
  clientKeys,
  updateBindingPreferences,
} from "../../client-interface/query-options";

export function SettingsPage() {
  const bootstrap = useQuery(bootstrapQueryOptions);
  if (!bootstrap.data) return null;
  return (
    <section className="settings-page">
      <header className="settings-header">
        <p className="settings-eyebrow">CONNECT CLIENT</p>
        <h1>安全偏好设置</h1>
        <p>这里仅开放显示名称、模型、推理强度和输出可见性。Runtime 启动参数与审批策略仍由本地配置控制。</p>
      </header>
      <div className="settings-list">
        {bootstrap.data.bindings.map((binding) => (
          <BindingSettings
            key={binding.bindingId}
            binding={binding}
            outputVisibility={bootstrap.data.outputVisibility}
          />
        ))}
      </div>
    </section>
  );
}

function BindingSettings({
  binding,
  outputVisibility,
}: {
  binding: BindingPreferenceView;
  outputVisibility: BootstrapView["outputVisibility"];
}) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(binding.displayName);
  const [model, setModel] = useState(binding.model ?? "");
  const [effort, setEffort] = useState(binding.modelReasoningEffort ?? "default");
  const [visibility, setVisibility] = useState(outputVisibility);
  useEffect(() => {
    setDisplayName(binding.displayName);
    setModel(binding.model ?? "");
    setEffort(binding.modelReasoningEffort ?? "default");
  }, [binding]);
  const save = useMutation({
    mutationFn: async () =>
      await updateBindingPreferences(binding.bindingId, {
        displayName,
        model: model.trim() || null,
        modelReasoningEffort: effort === "default" ? null : (effort as "minimal" | "low" | "medium" | "high" | "xhigh"),
        outputVisibility: visibility,
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.bootstrap });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  return (
    <Card className="settings-card">
      <div className="settings-card-heading">
        <div>
          <h2>{binding.displayName}</h2>
          <code>{binding.bindingId}</code>
        </div>
        <Button label="保存设置" variant="primary" isLoading={save.isPending} onClick={() => save.mutate()} />
      </div>
      {save.isSuccess ? <Banner status="success" title="设置已保存" container="section" isDismissable /> : null}
      {save.isError ? (
        <Banner status="error" title="保存失败" description={save.error.message} container="section" />
      ) : null}
      <div className="settings-fields">
        <TextInput label="显示名称" value={displayName} onChange={setDisplayName} width="100%" />
        <TextInput
          label="模型"
          description="留空时使用 Codex 的本地默认值。"
          value={model}
          onChange={setModel}
          placeholder="默认模型"
          isOptional
          width="100%"
        />
        <Selector
          label="推理强度"
          options={["default", "minimal", "low", "medium", "high", "xhigh"]}
          value={effort}
          onChange={setEffort}
          width="100%"
        />
        <Selector
          label="ClawChat 输出可见性"
          description="Web 始终尽可能展示完整的结构化输出。"
          options={["minimal", "normal", "full"]}
          value={visibility}
          onChange={(value) => setVisibility(value as BootstrapView["outputVisibility"])}
          width="100%"
        />
      </div>
    </Card>
  );
}

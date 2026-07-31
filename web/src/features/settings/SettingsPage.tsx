import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Selector } from "@astryxdesign/core/Selector";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import type { BindingPreferenceView, BootstrapView } from "../../../../src/client-contract";
import {
  addProject,
  bootstrapQueryOptions,
  catalogQueryOptions,
  clientKeys,
  projectsQueryOptions,
  removeProject,
  updateBindingPreferences,
} from "../../client-interface/query-options";

export function SettingsPage() {
  const bootstrap = useQuery(bootstrapQueryOptions);
  const projects = useQuery(projectsQueryOptions);
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
          <BindingSettings key={binding.bindingId} binding={binding} />
        ))}
        <ProjectSettings projects={projects.data ?? []} />
      </div>
    </section>
  );
}

function BindingSettings({ binding }: { binding: BindingPreferenceView }) {
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(binding.displayName);
  const [model, setModel] = useState(binding.model ?? "");
  const [effort, setEffort] = useState(binding.modelReasoningEffort ?? "default");
  const [visibility, setVisibility] = useState(binding.outputVisibility);
  const selectedModel =
    binding.modelOptions.find((option) => option.id === model) ??
    binding.modelOptions.find((option) => option.isDefault) ??
    binding.modelOptions[0];
  const effortOptions = ["default", ...(selectedModel?.supportedReasoningEfforts ?? [])];
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
        <SettingsField>
          <TextInput label="显示名称" value={displayName} onChange={setDisplayName} width="100%" />
        </SettingsField>
        <SettingsField description="默认值会跟随 Runtime Adapter；Session 仍可单独覆盖。">
          <Selector
            label="模型"
            options={[
              { value: "default", label: "Runtime 默认值" },
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
            disabledMessage="Runtime Adapter 不支持模型选择。"
            width="100%"
          />
        </SettingsField>
        <SettingsField>
          <Selector
            label="推理强度"
            options={effortOptions}
            value={effort}
            onChange={setEffort}
            isDisabled={!selectedModel}
            disabledMessage="Runtime Adapter 未提供可用模型。"
            width="100%"
          />
        </SettingsField>
        <SettingsField description="Web 始终尽可能展示完整的结构化输出。">
          <Selector
            label="ClawChat 输出可见性"
            options={["minimal", "normal", "full"]}
            value={visibility}
            onChange={(value) => setVisibility(value as BootstrapView["outputVisibility"])}
            width="100%"
          />
        </SettingsField>
      </div>
    </Card>
  );
}

function ProjectSettings({ projects }: { projects: Array<{ workspaceId: string; name: string; rootPath: string }> }) {
  const queryClient = useQueryClient();
  const [rootPath, setRootPath] = useState("");
  const [additionalDirectories, setAdditionalDirectories] = useState("");
  const add = useMutation({
    mutationFn: async () =>
      await addProject(
        rootPath,
        additionalDirectories
          .split(/[\n,]/u)
          .map((path) => path.trim())
          .filter(Boolean),
      ),
    onSuccess: () => {
      setRootPath("");
      setAdditionalDirectories("");
      void queryClient.invalidateQueries({ queryKey: clientKeys.projects });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: removeProject,
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.projects });
      void queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  return (
    <Card className="settings-card project-settings-card">
      <div className="settings-card-heading">
        <div>
          <h2>Projects</h2>
          <p>Project 路径只在本机管理，不会发送到 ClawChat。</p>
        </div>
        <Button
          label="添加 Project"
          variant="primary"
          isLoading={add.isPending}
          isDisabled={!rootPath.trim()}
          onClick={() => add.mutate()}
        />
      </div>
      {add.isError ? (
        <Banner status="error" title="添加失败" description={add.error.message} container="section" />
      ) : null}
      {remove.isError ? (
        <Banner status="error" title="移除失败" description={remove.error.message} container="section" />
      ) : null}
      <div className="settings-fields">
        <SettingsField>
          <TextInput label="根目录绝对路径" value={rootPath} onChange={setRootPath} width="100%" />
        </SettingsField>
        <SettingsField description="可选；用逗号分隔多个绝对路径。">
          <TextInput
            label="附加目录"
            value={additionalDirectories}
            onChange={setAdditionalDirectories}
            isOptional
            width="100%"
          />
        </SettingsField>
      </div>
      <div className="project-settings-list">
        {projects.length === 0 ? <p>尚未注册 Project。</p> : null}
        {projects.map((project) => (
          <div className="project-settings-row" key={project.workspaceId}>
            <div>
              <strong>{project.name}</strong>
              <code>{project.rootPath}</code>
            </div>
            <Button
              label="移除"
              size="sm"
              isLoading={remove.isPending && remove.variables === project.workspaceId}
              onClick={() => remove.mutate(project.workspaceId)}
            />
          </div>
        ))}
      </div>
    </Card>
  );
}

function SettingsField({ children, description }: { children: ReactNode; description?: string }) {
  return (
    <div className="settings-field">
      {children}
      {description ? <p className="settings-field-description">{description}</p> : null}
    </div>
  );
}

import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Card } from "@astryxdesign/core/Card";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
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
import { HostDirectoryPicker, projectDirectoryLabel } from "../projects/HostDirectoryPicker";

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
  const [directory, setDirectory] = useState<ProjectDirectoryRequest | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const add = useMutation({
    mutationFn: async () => {
      if (!directory) throw new Error("请先选择 Project 目录");
      return await addProject(directory);
    },
    onSuccess: () => {
      setDirectory(null);
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
    <>
      <Section>
        <VStack gap={4}>
          <HStack gap={4} hAlign="between" align="start">
            <VStack gap={1}>
              <Heading level={2}>Projects</Heading>
              <Text type="supporting">Project 路径位于 Connect 主机，不会发送到 ClawChat 消息。</Text>
            </VStack>
            <HStack gap={2}>
              <Button label="选择目录" variant="secondary" onClick={() => setPickerOpen(true)} />
              <Button
                label="添加 Project"
                variant="primary"
                isLoading={add.isPending}
                isDisabled={!directory}
                onClick={() => add.mutate()}
              />
            </HStack>
          </HStack>
          {directory ? (
            <Section variant="muted">
              <Text type="label">待添加目录</Text>
              <Text type="code" display="block" wordBreak="break-all">
                {projectDirectoryLabel(directory)}
              </Text>
            </Section>
          ) : null}
          {add.isError ? <Banner status="error" title="添加失败" description={add.error.message} /> : null}
          {remove.isError ? <Banner status="error" title="移除失败" description={remove.error.message} /> : null}
          <List density="compact" hasDividers header={<Text type="label">已注册 Project</Text>}>
            {projects.length === 0 ? <ListItem label="尚未注册 Project" isDisabled /> : null}
            {projects.map((project) => (
              <ListItem
                key={project.workspaceId}
                label={project.name}
                description={project.rootPath}
                endContent={
                  <Button
                    label="移除"
                    size="sm"
                    isLoading={remove.isPending && remove.variables === project.workspaceId}
                    onClick={() => remove.mutate(project.workspaceId)}
                  />
                }
              />
            ))}
          </List>
        </VStack>
      </Section>
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
              title="选择 Project 目录"
              subtitle="浏览运行 Connect Service 的主机。"
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
    </>
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

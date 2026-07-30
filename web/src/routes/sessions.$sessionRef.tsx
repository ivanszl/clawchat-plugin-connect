import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Popover } from "@astryxdesign/core/Popover";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useToast } from "@astryxdesign/core/Toast";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import type { SessionView } from "../../../src/client-contract";
import {
  archiveSession,
  bootstrapQueryOptions,
  catalogQueryOptions,
  clientKeys,
  deleteSession,
  sessionQueryOptions,
  transcriptQueryOptions,
  unarchiveSession,
  updateSessionPreferences,
} from "../client-interface/query-options";
import { MoreIcon } from "../components/icons";
import { SessionComposer } from "../features/composer/SessionComposer";
import { TranscriptViewport } from "../features/transcript/TranscriptViewport";
import { continueInClawChatHref, isClawChatLivewareContext } from "../liveware/clawchat-deep-link";

export const Route = createFileRoute("/sessions/$sessionRef")({ component: SessionPage });

function SessionPage() {
  const { sessionRef } = Route.useParams();
  const session = useQuery(sessionQueryOptions(sessionRef));
  const transcript = useInfiniteQuery(transcriptQueryOptions(sessionRef));
  const bootstrap = useQuery(bootstrapQueryOptions);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const toast = useToast();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const transcriptCompleteness = session.data?.transcriptCompleteness;
  useEffect(() => {
    if (!transcriptCompleteness || transcriptCompleteness === "complete") return;
    toast({
      body: transcriptCompletenessMessage(transcriptCompleteness),
      type: "info",
      uniqueID: `transcript-completeness:${sessionRef}`,
      collisionBehavior: "overwrite",
    });
  }, [sessionRef, toast, transcriptCompleteness]);
  const lifecycle = useMutation({
    mutationFn: async (action: "archive" | "unarchive" | "delete") => {
      if (action === "archive") return await archiveSession(sessionRef);
      if (action === "unarchive") return await unarchiveSession(sessionRef);
      return await deleteSession(sessionRef);
    },
    onSuccess: async (_response, action) => {
      await queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
      if (action === "delete") {
        queryClient.removeQueries({ queryKey: clientKeys.session(sessionRef) });
        queryClient.removeQueries({ queryKey: clientKeys.transcript(sessionRef) });
        await navigate({ to: "/" });
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) }),
        queryClient.invalidateQueries({ queryKey: clientKeys.transcript(sessionRef) }),
      ]);
    },
  });

  if (session.isPending || transcript.isPending) {
    return (
      <div className="centered-state">
        <Spinner label="正在打开 Session" />
      </div>
    );
  }
  if (session.isError || transcript.isError) {
    const error = session.error ?? transcript.error;
    return (
      <div className="centered-state">
        <Banner status="error" title="无法打开 Session" description={error?.message} />
      </div>
    );
  }
  const view = session.data;
  const binding = bootstrap.data?.bindings.find((candidate) => candidate.bindingId === view.bindingId);
  const clawChatHref = isClawChatLivewareContext(window.location.hostname, window.navigator.userAgent)
    ? continueInClawChatHref(binding?.clawChatUserId ?? null, view.sessionRef)
    : null;
  return (
    <section className="session-page">
      <header className="session-header">
        <div className="session-heading">
          <h1 title={view.name}>{view.name}</h1>
        </div>
        <div className="session-meta">
          <Badge label={view.bindingKind} variant="neutral" />
          {view.isArchived ? <Badge label="已归档" variant="neutral" /> : null}
          <Badge
            label={statusLabel(view.status)}
            variant={
              view.status === "error"
                ? "error"
                : view.status === "running"
                  ? "blue"
                  : view.status === "offline"
                    ? "warning"
                    : "success"
            }
          />
          <DropdownMenu
            button={{
              label: "Session 操作",
              isIconOnly: true,
              icon: <MoreIcon />,
              size: "sm",
              variant: "ghost",
              isLoading: lifecycle.isPending,
            }}
            hasChevron={false}
            placement="below"
            items={[
              view.isArchived
                ? {
                    label: "恢复 Session",
                    isDisabled: lifecycle.isPending,
                    onClick: () => lifecycle.mutate("unarchive"),
                  }
                : {
                    label: "归档 Session",
                    isDisabled: lifecycle.isPending,
                    onClick: () => lifecycle.mutate("archive"),
                  },
              { type: "divider" },
              {
                label: "永久删除 Session",
                isDisabled: lifecycle.isPending,
                onClick: () => setDeleteOpen(true),
              },
            ]}
          />
        </div>
      </header>
      <div className="session-notices">
        {view.isArchived ? (
          <Banner
            status="info"
            title="此 Session 已归档"
            description="历史消息仍可查看；恢复后才能继续发送消息。"
            container="section"
          />
        ) : null}
        {lifecycle.isError ? (
          <Banner
            status="error"
            title="Session 操作失败"
            description={lifecycle.error.message}
            container="section"
            isDismissable
            onDismiss={() => lifecycle.reset()}
          />
        ) : null}
      </div>
      <TranscriptViewport
        key={sessionRef}
        pages={transcript.data.pages}
        hasOlder={Boolean(transcript.hasNextPage)}
        isLoadingOlder={transcript.isFetchingNextPage}
        loadOlder={transcript.fetchNextPage}
      />
      <SessionComposer
        sessionRef={sessionRef}
        contextLabel={`${view.workspaceName || view.projectName || "Non-Project"} / ${view.sessionRef}`}
        continueInClawChatHref={clawChatHref}
        canSend={view.allowedActions.includes("send") && view.status !== "offline"}
        isRuntimeActive={view.status === "running" || view.status === "queued"}
        capability={view.turnSubmissionCapability}
        hasPendingInteraction={view.pendingInteractions.length > 0}
        modelControl={<SessionModelControls view={view} />}
      />
      <AlertDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="永久删除这个 Session？"
        description="这会删除原生 Runtime Thread 以及 Connect 保存的本地消息投影，且无法恢复。子 Thread 不会被 Connect 额外级联删除。"
        cancelLabel="取消"
        actionLabel="永久删除"
        isActionLoading={lifecycle.isPending}
        onAction={() => lifecycle.mutate("delete", { onSuccess: () => setDeleteOpen(false) })}
      />
    </section>
  );
}

function SessionModelControls({ view }: { view: SessionView }) {
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [model, setModel] = useState(view.model ?? "default");
  const [effort, setEffort] = useState(view.reasoningEffort ?? view.effectiveReasoningEffort ?? "default");
  useEffect(() => {
    setModel(view.model ?? "default");
    setEffort(view.reasoningEffort ?? view.effectiveReasoningEffort ?? "default");
  }, [view.effectiveReasoningEffort, view.model, view.reasoningEffort]);
  const selectedModel = view.modelOptions.find((option) => option.id === model);
  const effectiveModelOption = view.modelOptions.find((option) => option.id === view.effectiveModel);
  const unavailableModel =
    view.model && !view.modelOptions.some((option) => option.id === view.model) ? view.model : null;
  const compactLabel = `${effectiveModelOption?.displayName ?? view.effectiveModel ?? "Runtime 默认模型"} · ${
    view.effectiveReasoningEffort ?? "default"
  }`;
  const modelOptions = [
    { value: "default", label: "继承 Agent Binding / Runtime 默认值" },
    ...(unavailableModel ? [{ value: unavailableModel, label: `${unavailableModel}（不可用）` }] : []),
    ...view.modelOptions.map((option) => ({
      value: option.id,
      label: `${option.displayName} (${option.id})`,
    })),
  ];
  const save = useMutation({
    mutationFn: async () =>
      await updateSessionPreferences(
        view.sessionRef,
        model === "default" ? null : model,
        model === "default" ? null : effort,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.session(view.sessionRef), refetchType: "active" });
      setIsOpen(false);
    },
  });
  return (
    <Popover
      label="Session 模型设置"
      placement="above"
      alignment="end"
      width="min(340px, calc(100vw - 24px))"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      content={
        <div className="session-model-popover">
          <div className="session-model-popover-heading">
            <div>
              <strong>模型与推理强度</strong>
              <p>
                当前生效：{compactLabel}（
                {{ session: "Session", binding: "Agent Binding", runtime: "Runtime" }[view.modelSource]}）
              </p>
            </div>
            {!view.modelAvailable ? <Badge label="模型不可用" variant="error" /> : null}
          </div>
          <Selector
            label="Session 模型"
            options={modelOptions}
            value={model}
            onChange={(value) => {
              const option = view.modelOptions.find((candidate) => candidate.id === value);
              setModel(value);
              setEffort(option?.defaultReasoningEffort ?? view.effectiveReasoningEffort ?? "default");
            }}
            isDisabled={view.modelOptions.length === 0 && !unavailableModel}
            disabledMessage="Runtime Adapter 不支持模型选择。"
            width="100%"
          />
          <Selector
            label="推理强度"
            options={selectedModel?.supportedReasoningEfforts ?? [effort]}
            value={effort}
            onChange={setEffort}
            isDisabled={model === "default"}
            width="100%"
          />
          {save.isError ? <span className="form-error">{save.error.message}</span> : null}
          <div className="session-model-popover-actions">
            <Button
              label="应用模型设置"
              variant="primary"
              size="sm"
              isLoading={save.isPending}
              onClick={() => save.mutate()}
            />
          </div>
        </div>
      }
    >
      <Button
        className="composer-model-trigger"
        label={`模型设置：${compactLabel}`}
        variant="ghost"
        size="md"
        isLoading={save.isPending}
      >
        {compactLabel}
      </Button>
    </Popover>
  );
}

function statusLabel(status: "idle" | "running" | "queued" | "offline" | "error"): string {
  return { idle: "空闲", running: "运行中", queued: "排队中", offline: "离线", error: "错误" }[status];
}

function transcriptCompletenessMessage(
  completeness: Exclude<SessionView["transcriptCompleteness"], "complete">,
): string {
  return completeness === "partial"
    ? "部分工具执行细节可能缺失。"
    : "仅显示 Connect 已同步的消息；此 Session 的早期 Runtime 历史不可用。";
}

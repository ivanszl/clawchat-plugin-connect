import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { Button } from "@astryxdesign/core/Button";
import { Dialog, DialogHeader } from "@astryxdesign/core/Dialog";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Layout, LayoutContent, LayoutFooter } from "@astryxdesign/core/Layout";
import { Popover } from "@astryxdesign/core/Popover";
import { Selector } from "@astryxdesign/core/Selector";
import { Spinner } from "@astryxdesign/core/Spinner";
import { HStack, VStack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import type { BindingPreferenceView, SessionView } from "../../../src/client-contract";
import {
  archiveSession,
  bootstrapQueryOptions,
  catalogQueryOptions,
  changeSessionBinding,
  clientKeys,
  continueSession,
  deleteSession,
  sessionQueryOptions,
  slashSuggestionsQueryOptions,
  transcriptQueryOptions,
  unarchiveSession,
  updateSessionPreferences,
} from "../client-interface/query-options";
import { MoreIcon } from "../components/icons";
import {
  ArtifactDock,
  ArtifactMobileControls,
  useArtifactWorkspace,
} from "../features/artifacts/ArtifactWorkspaceView";
import { SessionComposer } from "../features/composer/SessionComposer";
import { TranscriptViewport } from "../features/transcript/TranscriptViewport";
import { type ClientTranslator, localizedClientError, useClientTranslator } from "../i18n/client-i18n";
import { continueInClawChatHref, isClawChatLivewareContext } from "../liveware/clawchat-deep-link";

export const Route = createFileRoute("/sessions/$sessionRef")({ component: SessionPage });

function SessionPage() {
  const t = useClientTranslator();
  const { sessionRef } = Route.useParams();
  const session = useQuery(sessionQueryOptions(sessionRef));
  const slashSuggestions = useQuery(slashSuggestionsQueryOptions(sessionRef));
  const transcript = useInfiniteQuery(transcriptQueryOptions(sessionRef));
  const bootstrap = useQuery(bootstrapQueryOptions);
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const [lifecycleOutcome, setLifecycleOutcome] = useState<"archive" | "unarchive" | null>(null);
  const artifactWorkspace = useArtifactWorkspace(sessionRef);
  const lifecycle = useMutation({
    mutationFn: async (action: "archive" | "unarchive" | "delete") => {
      if (action === "archive") return await archiveSession(sessionRef);
      if (action === "unarchive") return await unarchiveSession(sessionRef);
      return await deleteSession(sessionRef);
    },
    onMutate: () => setLifecycleOutcome(null),
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
      setLifecycleOutcome(action);
    },
  });
  const lifecycleMenuItems = useMemo(() => {
    const view = session.data;
    if (!view) return [];
    return [
      ...(view.allowedActions.includes(view.isArchived ? "unarchive" : "archive")
        ? [
            view.isArchived
              ? {
                  label: t("@connect.session.actions.restore"),
                  isDisabled: lifecycle.isPending,
                  onClick: () => {
                    setActionsOpen(false);
                    lifecycle.mutate("unarchive");
                  },
                }
              : {
                  label: t("@connect.session.actions.archive"),
                  isDisabled: lifecycle.isPending,
                  onClick: () => {
                    setActionsOpen(false);
                    lifecycle.mutate("archive");
                  },
                },
          ]
        : []),
      ...(view.allowedActions.includes("delete")
        ? [
            { type: "divider" as const },
            {
              label: t("@connect.session.actions.delete"),
              isDisabled: lifecycle.isPending,
              onClick: () => {
                setActionsOpen(false);
                setDeleteOpen(true);
              },
            },
          ]
        : []),
    ];
  }, [lifecycle.isPending, lifecycle.mutate, session.data, t]);

  if (session.isPending || transcript.isPending) {
    return (
      <div className="centered-state">
        <Spinner label={t("@connect.session.loading")} />
      </div>
    );
  }
  if (session.isError || transcript.isError) {
    const error = session.error ?? transcript.error;
    return (
      <div className="centered-state">
        <Banner status="error" title={t("@connect.session.loadFailure")} description={localizedClientError(t, error)} />
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
      <header className="session-header" data-artifact-open={artifactWorkspace.activeTab ? true : undefined}>
        <div className="session-heading">
          <h1 title={view.name}>{view.name}</h1>
        </div>
        <ArtifactMobileControls workspace={artifactWorkspace} />
        <div className="session-meta">
          <Badge label={view.bindingKind} variant="neutral" />
          {view.isArchived ? <Badge label={t("@connect.session.archived.badge")} variant="neutral" /> : null}
          <Badge
            label={statusLabel(view.status, t)}
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
            isMenuOpen={actionsOpen}
            onOpenChange={setActionsOpen}
            button={{
              label: t("@connect.session.actions.label"),
              isIconOnly: true,
              icon: <MoreIcon />,
              size: "sm",
              variant: "ghost",
              isLoading: lifecycle.isPending,
            }}
            hasChevron={false}
            placement="below"
            items={lifecycleMenuItems}
          />
        </div>
      </header>
      <div className="session-work-area" data-artifact-open={artifactWorkspace.activeTab ? true : undefined}>
        <div className="session-conversation">
          <div className="session-notices">
            <SessionAgentControls view={view} bindings={bootstrap.data?.bindings ?? []} />
            {!view.runtimeThreadAvailable && !view.allowedActions.includes("send") ? (
              <Banner
                status="warning"
                title={t("@connect.session.unavailable.title")}
                description={t("@connect.session.unavailable.description")}
                container="section"
              />
            ) : null}
            {view.isArchived ? (
              <Banner
                status="info"
                title={t("@connect.session.archived.title")}
                description={t("@connect.session.archived.description")}
                container="section"
              />
            ) : null}
            {lifecycleOutcome ? (
              <Banner
                status="success"
                title={t(
                  lifecycleOutcome === "archive" ? "@connect.session.archived.success" : "@connect.session.restored",
                )}
                container="section"
                isDismissable
                onDismiss={() => setLifecycleOutcome(null)}
              />
            ) : null}
            {lifecycle.isError ? (
              <Banner
                status="error"
                title={t("@connect.session.lifecycleFailure")}
                description={localizedClientError(t, lifecycle.error)}
                container="section"
                isDismissable
                onDismiss={() => lifecycle.reset()}
              />
            ) : null}
          </div>
          <div className="session-transcript-surface">
            <TranscriptViewport
              key={sessionRef}
              sessionRef={sessionRef}
              pages={transcript.data.pages}
              hasOlder={Boolean(transcript.hasNextPage)}
              isLoadingOlder={transcript.isFetchingNextPage}
              loadOlder={transcript.fetchNextPage}
              onOpenArtifact={artifactWorkspace.open}
              slashSuggestions={slashSuggestions.data?.entries ?? []}
            />
          </div>
          <div className="session-composer-surface">
            <SessionComposer
              sessionRef={sessionRef}
              contextLabel={`${view.workspaceName || t("@connect.navigation.unnamedWorkspace")} / ${view.sessionRef}`}
              continueInClawChatHref={clawChatHref}
              canSend={view.allowedActions.includes("send") && view.status !== "offline"}
              isRuntimeActive={view.status === "running" || view.status === "queued"}
              capability={view.turnSubmissionCapability}
              slashSuggestions={slashSuggestions.data?.entries ?? []}
              queuedTurns={view.queuedTurns}
              slashSuggestionsError={slashSuggestions.isError}
              hasPendingInteraction={view.pendingInteractions.length > 0}
              modelControl={<SessionModelControls view={view} />}
            />
          </div>
        </div>
        <ArtifactDock sessionRef={sessionRef} workspace={artifactWorkspace} />
      </div>
      <AlertDialog
        isOpen={deleteOpen}
        onOpenChange={setDeleteOpen}
        title={t("@connect.session.delete.title")}
        description={t("@connect.session.delete.description")}
        cancelLabel={t("@connect.session.delete.cancel")}
        actionLabel={t("@connect.session.delete.action")}
        isActionLoading={lifecycle.isPending}
        onAction={() => lifecycle.mutate("delete", { onSuccess: () => setDeleteOpen(false) })}
      />
    </section>
  );
}

function SessionAgentControls({ view, bindings }: { view: SessionView; bindings: BindingPreferenceView[] }) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const eligibleBindings = useMemo(() => bindings.filter((binding) => binding.clawChatUserId !== null), [bindings]);
  const continuationBindings = useMemo(
    () => eligibleBindings.filter((binding) => binding.bindingId !== view.bindingId),
    [eligibleBindings, view.bindingId],
  );
  const [selectedBindingId, setSelectedBindingId] = useState(view.bindingId);
  const [continuationBindingId, setContinuationBindingId] = useState(continuationBindings[0]?.bindingId ?? "");
  const [continuationOpen, setContinuationOpen] = useState(false);
  useEffect(() => {
    setSelectedBindingId(view.bindingId);
    setContinuationBindingId((current) =>
      continuationBindings.some((binding) => binding.bindingId === current)
        ? current
        : (continuationBindings[0]?.bindingId ?? ""),
    );
  }, [continuationBindings, view.bindingId]);
  const bindingOptions = eligibleBindings.map((binding) => ({
    value: binding.bindingId,
    label: `${binding.displayName} (${binding.bindingId})`,
  }));
  const continuationOptions = continuationBindings.map((binding) => ({
    value: binding.bindingId,
    label: `${binding.displayName} (${binding.bindingId})`,
  }));
  const change = useMutation({
    mutationFn: async () => await changeSessionBinding(view.sessionRef, selectedBindingId),
    onSuccess: async (updated) => {
      queryClient.setQueryData(clientKeys.session(view.sessionRef), updated);
      await queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
    },
  });
  const continuation = useMutation({
    mutationFn: async () => await continueSession(view.sessionRef, continuationBindingId),
    onSuccess: async (created) => {
      setContinuationOpen(false);
      await queryClient.invalidateQueries({ queryKey: catalogQueryOptions.queryKey });
      await navigate({ to: "/sessions/$sessionRef", params: { sessionRef: created.sessionRef } });
    },
  });
  return (
    <VStack gap={2}>
      {view.bindingLocked ? (
        view.bindingLockReason === "accepted-turn" ? (
          <Banner
            status="info"
            title={t("@connect.session.agent.fixed.title")}
            description={t("@connect.session.agent.fixed.acceptedTurn")}
            container="section"
          />
        ) : null
      ) : (
        <VStack gap={2}>
          <Selector
            label={t("@connect.session.agent.empty.label")}
            description={t("@connect.session.agent.empty.description")}
            options={bindingOptions}
            value={selectedBindingId}
            onChange={setSelectedBindingId}
            isDisabled={bindingOptions.length < 2 || change.isPending}
            disabledMessage={t("@connect.session.agent.empty.unavailable")}
            width="100%"
          />
          <HStack justify="end">
            <Button
              label={t("@connect.session.agent.empty.action")}
              variant="secondary"
              isLoading={change.isPending}
              isDisabled={selectedBindingId === view.bindingId}
              onClick={() => change.mutate()}
            />
          </HStack>
          {change.isError ? (
            <Banner
              status="error"
              title={t("@connect.session.agent.changeFailure")}
              description={localizedClientError(t, change.error)}
            />
          ) : null}
        </VStack>
      )}
      {view.bindingLocked ? (
        <HStack justify="end">
          <Button
            label={t("@connect.session.continue.action")}
            variant="secondary"
            isDisabled={continuationBindings.length === 0}
            onClick={() => setContinuationOpen(true)}
          />
        </HStack>
      ) : null}
      <Dialog
        isOpen={continuationOpen}
        onOpenChange={(isOpen) => {
          if (!continuation.isPending) setContinuationOpen(isOpen);
        }}
        purpose="form"
        width={520}
      >
        <Layout
          height="auto"
          header={
            <DialogHeader
              title={t("@connect.session.continue.title")}
              subtitle={t("@connect.session.continue.subtitle")}
              onOpenChange={setContinuationOpen}
            />
          }
          content={
            <LayoutContent>
              <VStack gap={4}>
                <Banner
                  status="warning"
                  title={t("@connect.session.continue.warning.title")}
                  description={t("@connect.session.continue.warning.description")}
                />
                <Selector
                  label={t("@connect.session.continue.binding.label")}
                  description={t("@connect.session.continue.binding.description")}
                  options={continuationOptions}
                  value={continuationBindingId}
                  onChange={setContinuationBindingId}
                  width="100%"
                />
                <Text>{t("@connect.session.continue.workspace", { workspace: view.workspaceName ?? "" })}</Text>
                {continuation.isError ? (
                  <Banner
                    status="error"
                    title={t("@connect.session.continue.failure")}
                    description={localizedClientError(t, continuation.error)}
                  />
                ) : null}
              </VStack>
            </LayoutContent>
          }
          footer={
            <LayoutFooter hasDivider>
              <HStack gap={2} justify="end">
                <Button label={t("@connect.session.continue.cancel")} onClick={() => setContinuationOpen(false)} />
                <Button
                  label={t("@connect.session.continue.confirm")}
                  variant="primary"
                  isLoading={continuation.isPending}
                  isDisabled={!continuationBindingId}
                  onClick={() => continuation.mutate()}
                />
              </HStack>
            </LayoutFooter>
          }
        />
      </Dialog>
    </VStack>
  );
}

function SessionModelControls({ view }: { view: SessionView }) {
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const [isOpen, setIsOpen] = useState(false);
  const [model, setModel] = useState(view.model ?? "default");
  const [effort, setEffort] = useState(view.reasoningEffort ?? view.effectiveReasoningEffort ?? "default");
  const [sessionOptions, setSessionOptions] = useState(view.sessionOptions);
  useEffect(() => {
    setModel(view.model ?? "default");
    setEffort(view.reasoningEffort ?? view.effectiveReasoningEffort ?? "default");
    setSessionOptions(view.sessionOptions);
  }, [view.effectiveReasoningEffort, view.model, view.reasoningEffort, view.sessionOptions]);
  const selectedModel = view.modelOptions.find((option) => option.id === model);
  const effectiveModelOption = view.modelOptions.find((option) => option.id === view.effectiveModel);
  const unavailableModel =
    view.model && !view.modelOptions.some((option) => option.id === view.model) ? view.model : null;
  const usesGenericModelOptions = view.sessionOptionDefinitions.some(
    (definition) => definition.category === "model" || definition.category === "variant",
  );
  const compactLabel = usesGenericModelOptions
    ? [sessionOptions.agent, sessionOptions.model, sessionOptions.variant].filter(Boolean).join(" · ") ||
      t("@connect.composer.model.runtimeNativeDefault")
    : `${effectiveModelOption?.displayName ?? view.effectiveModel ?? t("@connect.composer.model.runtimeDefaultModel")} · ${
        view.effectiveReasoningEffort ?? t("@connect.composer.model.runtimeDefaultReasoning")
      }`;
  const modelOptions = [
    { value: "default", label: t("@connect.composer.model.inheritDefault") },
    ...(unavailableModel
      ? [{ value: unavailableModel, label: t("@connect.composer.model.unavailableValue", { value: unavailableModel }) }]
      : []),
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
        sessionOptions,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: clientKeys.session(view.sessionRef), refetchType: "active" });
      setIsOpen(false);
    },
  });
  return (
    <Popover
      label={t("@connect.composer.model.popoverLabel")}
      placement="above"
      alignment="end"
      width="min(340px, calc(100vw - 24px))"
      isOpen={isOpen}
      onOpenChange={setIsOpen}
      content={
        <div className="session-model-popover">
          <div className="session-model-popover-heading">
            <div>
              <strong>
                {usesGenericModelOptions
                  ? t("@connect.composer.model.runtimeOptions")
                  : t("@connect.composer.model.heading")}
              </strong>
              <p>
                {t("@connect.composer.model.effective", {
                  value: compactLabel,
                  source: {
                    session: t("@connect.composer.model.source.session"),
                    binding: t("@connect.composer.model.source.binding"),
                    runtime: t("@connect.composer.model.source.runtime"),
                  }[view.modelSource],
                })}
              </p>
            </div>
            {!view.modelAvailable ? <Badge label={t("@connect.composer.model.unavailable")} variant="error" /> : null}
          </div>
          {!usesGenericModelOptions ? (
            <Selector
              label={t("@connect.composer.model.selectorLabel")}
              options={modelOptions}
              value={model}
              onChange={(value) => {
                const option = view.modelOptions.find((candidate) => candidate.id === value);
                setModel(value);
                setEffort(option?.defaultReasoningEffort ?? view.effectiveReasoningEffort ?? "default");
              }}
              isDisabled={view.modelOptions.length === 0 && !unavailableModel}
              disabledMessage={t("@connect.composer.model.unsupported")}
              width="100%"
            />
          ) : null}
          {view.sessionOptionDefinitions.map((definition) => {
            const selected = sessionOptions[definition.id] ?? "default";
            const values = [
              { value: "default", label: t("@connect.composer.model.useRuntimeDefault") },
              ...definition.values
                .filter(
                  (value) =>
                    !value.availableWhen ||
                    Object.entries(value.availableWhen).every(
                      ([optionId, expected]) => sessionOptions[optionId] === expected,
                    ),
                )
                .map((value) => ({
                  value: value.id,
                  label: value.unavailable
                    ? t("@connect.composer.model.unavailableValue", { value: value.displayName })
                    : value.displayName,
                })),
            ];
            return (
              <Selector
                key={definition.id}
                label={definition.displayName}
                options={values}
                value={selected}
                onChange={(value) =>
                  setSessionOptions((current) => {
                    const next = { ...current };
                    if (value === "default") delete next[definition.id];
                    else next[definition.id] = value;
                    for (const dependent of view.sessionOptionDefinitions) {
                      const selectedDependent = next[dependent.id];
                      const selectedValue = dependent.values.find((candidate) => candidate.id === selectedDependent);
                      if (
                        selectedValue?.availableWhen?.[definition.id] &&
                        selectedValue.availableWhen[definition.id] !== next[definition.id]
                      )
                        delete next[dependent.id];
                    }
                    return next;
                  })
                }
                isDisabled={definition.changePolicy !== "in-place"}
                disabledMessage={t("@connect.composer.model.requiresNewRuntimeSession")}
                width="100%"
              />
            );
          })}
          {!usesGenericModelOptions ? (
            <Selector
              label={t("@connect.composer.model.reasoningLabel")}
              options={selectedModel?.supportedReasoningEfforts ?? [effort]}
              value={effort}
              onChange={setEffort}
              isDisabled={model === "default"}
              width="100%"
            />
          ) : null}
          {save.isError ? <span className="form-error">{localizedClientError(t, save.error)}</span> : null}
          <div className="session-model-popover-actions">
            <Button
              label={t("@connect.composer.model.apply")}
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
        label={t("@connect.composer.model.trigger", { value: compactLabel })}
        variant="ghost"
        size="md"
        isLoading={save.isPending}
      >
        {compactLabel}
      </Button>
    </Popover>
  );
}

function statusLabel(status: "idle" | "running" | "queued" | "offline" | "error", t: ClientTranslator): string {
  return {
    idle: t("@connect.session.status.idle"),
    running: t("@connect.session.status.running"),
    queued: t("@connect.session.status.queued"),
    offline: t("@connect.session.status.offline"),
    error: t("@connect.session.status.error"),
  }[status];
}

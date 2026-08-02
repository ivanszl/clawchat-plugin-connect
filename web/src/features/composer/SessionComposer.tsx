import { Button } from "@astryxdesign/core/Button";
import { ButtonGroup } from "@astryxdesign/core/ButtonGroup";
import {
  ChatComposer,
  ChatComposerDrawer,
  ChatComposerInput,
  type ChatComposerTrigger,
  ChatSendButton,
} from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Stack } from "@astryxdesign/core/Layout";
import { List, ListItem } from "@astryxdesign/core/List";
import { ProgressBar } from "@astryxdesign/core/ProgressBar";
import { Spinner } from "@astryxdesign/core/Spinner";
import { Token } from "@astryxdesign/core/Token";
import { createStaticSource, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Paperclip, RotateCcw, Square, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { QueuedTurnView, SlashSuggestionView, TurnSubmissionCapability } from "../../../../src/client-contract";
import { attachmentKind, mediaTypeAllowed } from "../../../../src/client-interface/turn-submission";
import { cancelTurn, clientKeys, withdrawQueuedTurn } from "../../client-interface/query-options";
import {
  keepsSlashSelection,
  slashSuggestionFromItem,
  slashSuggestionItems,
  slashSuggestionToken,
} from "../slash-suggestions";
import { useTurnSubmission } from "./useTurnSubmission";

interface OptimisticQueuedTurn extends QueuedTurnView {
  optimisticId: string;
  acceptedTurnId: string | null;
}

interface ActiveSubmissionDraft {
  prompt: string;
  files: File[];
  selection: SlashSuggestionView | null;
}

export interface SessionComposerProps {
  sessionRef: string;
  contextLabel: string;
  continueInClawChatHref: string | null;
  canSend: boolean;
  isRuntimeActive: boolean;
  capability: TurnSubmissionCapability;
  slashSuggestions: SlashSuggestionView[];
  queuedTurns: QueuedTurnView[];
  slashSuggestionsError?: boolean;
  hasPendingInteraction?: boolean;
  modelControl?: ReactNode;
}

export function SessionComposer({
  sessionRef,
  contextLabel,
  continueInClawChatHref,
  canSend,
  isRuntimeActive,
  capability,
  slashSuggestions,
  queuedTurns,
  slashSuggestionsError = false,
  hasPendingInteraction = false,
  modelControl,
}: SessionComposerProps) {
  const queryClient = useQueryClient();
  const storageKey = `connect-client:draft:${sessionRef}`;
  const [value, setValue] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [acceptedTurnId, setAcceptedTurnId] = useState<string | null>(null);
  const [selectedSelection, setSelectedSelection] = useState<SlashSuggestionView | null>(null);
  const [activeSubmission, setActiveSubmission] = useState<ActiveSubmissionDraft | null>(null);
  const [optimisticQueuedTurns, setOptimisticQueuedTurns] = useState<OptimisticQueuedTurn[]>([]);
  const [hiddenQueuedTurnIds, setHiddenQueuedTurnIds] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLDivElement>(null);
  const optimisticSequenceRef = useRef(0);
  useEffect(() => {
    const next = sessionStorage.getItem(storageKey) ?? "";
    setValue(next);
    setAttachments([]);
    setAttachmentError(null);
    setAcceptedTurnId(null);
    setSelectedSelection(null);
    setActiveSubmission(null);
    setOptimisticQueuedTurns([]);
    setHiddenQueuedTurnIds([]);
  }, [storageKey]);
  useEffect(() => {
    if (!value) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, value);
  }, [storageKey, value]);
  useEffect(() => {
    if (acceptedTurnId && !isRuntimeActive) setAcceptedTurnId(null);
  }, [acceptedTurnId, isRuntimeActive]);
  useEffect(() => {
    setOptimisticQueuedTurns((current) =>
      current.filter(
        (turn) => !turn.acceptedTurnId || !queuedTurns.some((queued) => queued.turnId === turn.acceptedTurnId),
      ),
    );
    setHiddenQueuedTurnIds((current) =>
      current.filter((turnId) => queuedTurns.some((queued) => queued.turnId === turnId)),
    );
  }, [queuedTurns]);
  useEffect(() => {
    const input = composerInputRef.current;
    if (!input) return;
    const updateMenuBounds = () => {
      const bounds = input.getBoundingClientRect();
      const layer = input.querySelector<HTMLElement>("[popover]:has(.astryx-trigger-menu)");
      if (!layer) return;
      for (const property of ["position-anchor", "position-area", "position-try-fallbacks"]) {
        if (layer.style.getPropertyValue(property)) layer.style.removeProperty(property);
      }
      const desired = {
        position: "fixed",
        inset: `auto auto calc(${window.innerHeight - bounds.top}px + var(--spacing-1)) ${bounds.left}px`,
        width: `${bounds.width}px`,
        "min-width": "0px",
        "max-width": `${bounds.width}px`,
      };
      for (const [property, next] of Object.entries(desired)) {
        if (layer.style.getPropertyValue(property) !== next) layer.style.setProperty(property, next);
      }
    };
    const resizeObserver = new ResizeObserver(updateMenuBounds);
    const menuObserver = new MutationObserver(updateMenuBounds);
    resizeObserver.observe(input);
    menuObserver.observe(input, { childList: true, subtree: true, attributes: true, attributeFilter: ["style"] });
    window.addEventListener("resize", updateMenuBounds);
    window.addEventListener("scroll", updateMenuBounds, true);
    updateMenuBounds();
    return () => {
      resizeObserver.disconnect();
      menuObserver.disconnect();
      window.removeEventListener("resize", updateMenuBounds);
      window.removeEventListener("scroll", updateMenuBounds, true);
    };
  }, []);
  const send = useTurnSubmission(sessionRef);
  const addFiles = (files: File[]) => {
    setAttachmentError(null);
    const oversized = files.find((file) => file.size > capability.attachments.maxBytesEach);
    if (oversized) {
      setAttachmentError(`${oversized.name} 超过单个附件限制，无法上传`);
      return;
    }
    const unsupported = files.find(
      (file) =>
        !capability.attachments.allowedKinds.includes(attachmentKind(file.type) ?? "file") ||
        !mediaTypeAllowed(file.type, capability.attachments.allowedMediaTypes),
    );
    if (unsupported) {
      setAttachmentError(`${unsupported.name} 不受当前 Turn Submission 支持`);
      return;
    }
    setAttachments((current) => {
      const next = [...current, ...files];
      if (next.length > capability.attachments.maxCount) {
        setAttachmentError(`每条消息最多上传 ${capability.attachments.maxCount} 个文件`);
        return current;
      }
      if (next.reduce((total, file) => total + file.size, 0) > capability.attachments.maxBytesTotal) {
        setAttachmentError("附件总大小超过当前提交限制");
        return current;
      }
      return next;
    });
  };
  const setComposerValue = (next: string) => {
    setValue(next);
    if (selectedSelection && !keepsSlashSelection(next, selectedSelection)) setSelectedSelection(null);
  };
  const slashTrigger = useMemo<ChatComposerTrigger>(() => {
    const items = slashSuggestionItems(slashSuggestions);
    return {
      character: "/",
      searchSource: createStaticSource(items, {
        keywords: (item) => [item.auxiliaryData?.description ?? "", item.auxiliaryData?.group ?? ""],
      }),
      renderItem: (item) => {
        const suggestion = slashSuggestionFromItem(item);
        return (
          <TypeaheadItem
            item={item}
            description={suggestion?.description}
            group={suggestion?.kind === "skill" ? "Skills" : "Commands"}
          />
        );
      },
      onSelect: (item) => {
        const suggestion = slashSuggestionFromItem(item);
        if (!suggestion) return item.label;
        setSelectedSelection(suggestion);
        return slashSuggestionToken(suggestion);
      },
      deserialize: (serialized) => {
        const suggestion = slashSuggestions.find((entry) => `/${entry.name}` === serialized);
        return suggestion ? slashSuggestionToken(suggestion) : null;
      },
      emptySearchResultsText: slashSuggestionsError ? "命令和 Skills 加载失败，请稍后重试" : "没有匹配的命令或 Skill",
      loadingText: "正在载入命令和 Skills…",
      menuLabel: "命令和 Skills",
    };
  }, [slashSuggestions, slashSuggestionsError]);
  const submit = (prompt: string) => {
    if (!send.isPending && (prompt.trim() || attachments.length > 0)) {
      const draft = { prompt, files: [...attachments], selection: selectedSelection };
      const shouldShowInQueue = isRuntimeActive || queuedTurns.length > 0;
      const optimisticId = `optimistic-${++optimisticSequenceRef.current}`;
      setActiveSubmission(draft);
      if (shouldShowInQueue) {
        setOptimisticQueuedTurns((current) => [
          ...current,
          {
            optimisticId,
            acceptedTurnId: null,
            turnId: optimisticId,
            prompt,
            selection: selectedSelection,
            attachments: attachments.map((file) => ({ name: file.name })),
            createdAt: new Date().toISOString(),
          },
        ]);
      }
      setValue("");
      setSelectedSelection(null);
      setAttachments([]);
      setAttachmentError(null);
      send.mutate(draft, {
        onSuccess: (response) => {
          setOptimisticQueuedTurns((current) =>
            current.map((turn) =>
              turn.optimisticId === optimisticId ? { ...turn, acceptedTurnId: response.turnId } : turn,
            ),
          );
          setAcceptedTurnId(response.turnId);
          void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) });
        },
        onError: () => {
          setOptimisticQueuedTurns((current) => current.filter((turn) => turn.optimisticId !== optimisticId));
          setValue(prompt);
          setSelectedSelection(draft.selection);
          setAttachments(draft.files);
        },
        onSettled: () => setActiveSubmission(null),
      });
    }
  };
  const stop = useMutation({
    mutationFn: async () => await cancelTurn(sessionRef, acceptedTurnId ?? "active"),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) }),
  });
  const withdraw = useMutation({
    mutationFn: async ({ turn }: { turn: QueuedTurnView; restore: boolean }) => {
      await withdrawQueuedTurn(sessionRef, turn.turnId);
    },
    onSettled: () => void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) }),
  });
  const withdrawTurn = (turn: QueuedTurnView, restore: boolean) => {
    setHiddenQueuedTurnIds((current) => (current.includes(turn.turnId) ? current : [...current, turn.turnId]));
    if (restore) {
      setValue(turn.prompt);
      setSelectedSelection(turn.selection);
      if (turn.attachments.length > 0) setAttachmentError("队列附件已移除，请重新选择后再发送");
    }
    withdraw.mutate(
      { turn, restore },
      {
        onError: () => setHiddenQueuedTurnIds((current) => current.filter((turnId) => turnId !== turn.turnId)),
      },
    );
  };
  const visibleQueuedTurns = queuedTurns.filter((turn) => !hiddenQueuedTurnIds.includes(turn.turnId));
  const visibleOptimisticTurns = optimisticQueuedTurns.filter(
    (turn) => !turn.acceptedTurnId || !visibleQueuedTurns.some((queued) => queued.turnId === turn.acceptedTurnId),
  );
  const queueCount = visibleOptimisticTurns.length + visibleQueuedTurns.length;
  const error = attachmentError ?? send.error?.message ?? stop.error?.message ?? withdraw.error?.message;
  const composerDisabled = !canSend || hasPendingInteraction || send.isPending;
  const isAgentWorking = Boolean(acceptedTurnId) || isRuntimeActive;
  const hasSubmissionDraft = Boolean(value.trim() || attachments.length > 0);
  const hasSubmissionAttachments = send.isPending ? (activeSubmission?.files.length ?? 0) > 0 : attachments.length > 0;
  const attachmentLimitLabel =
    capability.attachments.maxCount === 0
      ? "当前 Turn Submission 不支持附件"
      : `最多 ${capability.attachments.maxCount} 个附件，单个 ${formatBytes(
          capability.attachments.maxBytesEach,
        )}，合计 ${formatBytes(capability.attachments.maxBytesTotal)}`;
  return (
    <div className="composer-region">
      {queueCount > 0 ? (
        <List className="composer-queue" density="compact" hasDividers header={`待发送队列 · ${queueCount}`}>
          {visibleOptimisticTurns.map((turn) => (
            <ListItem
              key={turn.optimisticId}
              label={turn.prompt || "仅附件消息"}
              description="正在提交"
              endContent={<Spinner size="sm" />}
            />
          ))}
          {visibleQueuedTurns.map((turn) => (
            <ListItem
              key={turn.turnId}
              label={turn.prompt || "仅附件消息"}
              description={queuedTurnDescription(turn)}
              endContent={
                <ButtonGroup label="队列消息操作" size="sm">
                  <Button
                    label="撤回并编辑"
                    icon={<Icon icon={RotateCcw} size="sm" />}
                    size="sm"
                    variant="secondary"
                    isLoading={withdraw.isPending && withdraw.variables?.turn.turnId === turn.turnId}
                    onClick={() => withdrawTurn(turn, true)}
                  />
                  <Button
                    label="删除"
                    icon={<Icon icon={Trash2} size="sm" />}
                    size="sm"
                    variant="secondary"
                    isDisabled={withdraw.isPending}
                    onClick={() => withdrawTurn(turn, false)}
                  />
                </ButtonGroup>
              }
            />
          ))}
        </List>
      ) : null}
      {send.isPending && send.progress ? (
        <ProgressBar
          className="composer-submission-progress"
          label={
            hasSubmissionAttachments
              ? send.progress.phase === "accepting"
                ? "附件传输完成，正在确认提交"
                : "正在传输附件"
              : send.progress.phase === "accepting"
                ? "正在确认提交"
                : "正在提交消息"
          }
          value={send.progress.transferredBytes}
          max={Math.max(1, send.progress.totalBytes)}
          hasValueLabel={send.progress.phase === "transferring" && send.progress.totalBytes > 0}
          formatValueLabel={(transferred, total) => `${formatBytes(transferred)} / ${formatBytes(total)}`}
          isIndeterminate={send.progress.phase === "accepting" || send.progress.totalBytes === 0}
        />
      ) : null}
      <ChatComposer
        className="session-composer"
        value={value}
        onChange={setComposerValue}
        onSubmit={submit}
        onStop={() => {
          if (!stop.isPending) stop.mutate();
        }}
        isStopShown={isAgentWorking && !hasSubmissionDraft}
        isDisabled={composerDisabled}
        placeholder={
          hasPendingInteraction
            ? "请先完成上方审批或回答"
            : canSend
              ? "给 Agent 发送消息…"
              : "当前 Session 不可发送消息"
        }
        status={error ? { type: "error", message: error } : undefined}
        density="balanced"
        input={
          <ChatComposerInput
            ref={composerInputRef}
            value={value}
            onChange={setComposerValue}
            onFiles={addFiles}
            triggers={[slashTrigger]}
            debounceMs={0}
            placeholder={
              hasPendingInteraction
                ? "请先完成上方审批或回答"
                : canSend
                  ? "给 Agent 发送消息…"
                  : "当前 Session 不可发送消息"
            }
            isDisabled={composerDisabled}
          />
        }
        drawer={
          attachments.length > 0 ? (
            <ChatComposerDrawer count={attachments.length} label="附件">
              <Stack direction="horizontal" gap={1} width="100%" wrap="wrap">
                {attachments.map((file, index) => (
                  <Token
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    label={file.name}
                    description={`${file.name}，${formatBytes(file.size)}`}
                    size="sm"
                    onRemove={() => setAttachments((current) => current.filter((_, item) => item !== index))}
                  />
                ))}
              </Stack>
            </ChatComposerDrawer>
          ) : undefined
        }
        headerActions={
          <>
            <input
              ref={fileInputRef}
              className="composer-file-input"
              type="file"
              multiple
              accept={capability.attachments.allowedMediaTypes.join(",")}
              onChange={(event) => {
                addFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = "";
              }}
            />
            <Button
              label="上传媒体文件"
              tooltip={attachmentLimitLabel}
              icon={<Icon icon={Paperclip} size="sm" />}
              isIconOnly
              size="sm"
              variant="ghost"
              isDisabled={composerDisabled || capability.attachments.maxCount === 0}
              onClick={() => fileInputRef.current?.click()}
            />
          </>
        }
        footerActions={
          <div className="composer-context-actions">
            <span className="composer-note" title={contextLabel}>
              {contextLabel}
            </span>
            {continueInClawChatHref ? (
              <>
                <span className="continue-clawchat-desktop">
                  <Button label="继续在 ClawChat 聊天" href={continueInClawChatHref} size="sm" variant="ghost" />
                </span>
                <span className="continue-clawchat-mobile">
                  <Button
                    label="继续在 ClawChat 聊天"
                    tooltip="继续在 ClawChat 聊天"
                    href={continueInClawChatHref}
                    icon={<Icon icon={MessageCircle} size="sm" />}
                    isIconOnly
                    size="sm"
                    variant="ghost"
                  />
                </span>
              </>
            ) : null}
          </div>
        }
        sendActions={modelControl}
        sendButton={
          send.isPending ? (
            <Button
              label={send.progress?.phase === "accepting" ? "正在确认" : "取消提交"}
              isLoading={send.progress?.phase === "accepting"}
              size="md"
              variant="secondary"
              onClick={send.cancel}
            />
          ) : isAgentWorking && !hasSubmissionDraft ? (
            <Button
              label="停止"
              tooltip="停止当前任务"
              icon={
                stop.isPending ? (
                  <Icon icon={Square} size="sm" />
                ) : (
                  <span data-testid="agent-working-spinner" aria-hidden="true">
                    <Spinner size="sm" />
                  </span>
                )
              }
              size="md"
              variant="secondary"
              isLoading={stop.isPending}
              isDisabled={stop.isPending}
              onClick={() => stop.mutate()}
            />
          ) : (
            <ChatSendButton isDisabled={composerDisabled || !hasSubmissionDraft} onSend={() => submit(value)} />
          )
        }
      />
      <VisuallyHidden as="div" aria-live="polite">
        {send.isPending
          ? hasSubmissionAttachments
            ? send.progress?.phase === "accepting"
              ? "附件传输完成，正在确认提交"
              : `正在传输 ${send.progress?.transferredBytes ?? 0} / ${send.progress?.totalBytes ?? 0} 字节`
            : send.progress?.phase === "accepting"
              ? "正在确认提交"
              : "正在提交消息"
          : isAgentWorking
            ? "Agent 正在工作，可以点击停止"
            : ""}
      </VisuallyHidden>
    </div>
  );
}

function queuedTurnDescription(turn: QueuedTurnView): string {
  const parts = [turn.selection ? `/${turn.selection.name}` : null];
  if (turn.attachments.length > 0) parts.push(`${turn.attachments.length} 个附件`);
  return parts.filter(Boolean).join(" · ") || "等待当前任务完成后发送";
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

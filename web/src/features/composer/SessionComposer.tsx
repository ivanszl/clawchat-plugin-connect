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
import { Spinner } from "@astryxdesign/core/Spinner";
import { Token } from "@astryxdesign/core/Token";
import { createStaticSource, TypeaheadItem } from "@astryxdesign/core/Typeahead";
import { VisuallyHidden } from "@astryxdesign/core/VisuallyHidden";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Paperclip, RotateCcw, Square, Trash2 } from "lucide-react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import type { QueuedTurnView, SlashSuggestionView, TurnSubmissionCapability } from "../../../../src/client-contract";
import { attachmentKind, mediaTypeAllowed } from "../../../../src/client-interface/turn-submission";
import { requestId } from "../../client-interface/http";
import { cancelTurn, clientKeys, withdrawQueuedTurn } from "../../client-interface/query-options";
import { type ClientTranslator, useClientTranslator } from "../../i18n/client-i18n";
import {
  keepsSlashSelection,
  slashSuggestionFromItem,
  slashSuggestionItems,
  slashSuggestionToken,
} from "../slash-suggestions";
import { useTurnSubmission } from "./useTurnSubmission";

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
  const t = useClientTranslator();
  const queryClient = useQueryClient();
  const storageKey = `connect-client:draft:${sessionRef}`;
  const [value, setValue] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [acceptedTurnId, setAcceptedTurnId] = useState<string | null>(null);
  const [selectedSelection, setSelectedSelection] = useState<SlashSuggestionView | null>(null);
  const [hiddenQueuedTurnIds, setHiddenQueuedTurnIds] = useState<string[]>([]);
  const [completionAnnouncement, setCompletionAnnouncement] = useState("");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const composerInputRef = useRef<HTMLDivElement>(null);
  const wasAgentWorkingRef = useRef(false);
  useEffect(() => {
    const next = sessionStorage.getItem(storageKey) ?? "";
    setValue(next);
    setAttachments([]);
    setAttachmentError(null);
    setAcceptedTurnId(null);
    setSelectedSelection(null);
    setHiddenQueuedTurnIds([]);
    setCompletionAnnouncement("");
    wasAgentWorkingRef.current = false;
  }, [storageKey]);
  useEffect(() => {
    if (!value) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, value);
  }, [storageKey, value]);
  useEffect(() => {
    if (acceptedTurnId && !isRuntimeActive) setAcceptedTurnId(null);
  }, [acceptedTurnId, isRuntimeActive]);
  useEffect(() => {
    const isWorking = Boolean(acceptedTurnId) || isRuntimeActive;
    if (wasAgentWorkingRef.current && !isWorking) setCompletionAnnouncement(t("@connect.composer.turnCompleted"));
    else if (isWorking) setCompletionAnnouncement("");
    wasAgentWorkingRef.current = isWorking;
  }, [acceptedTurnId, isRuntimeActive, t]);

  useEffect(() => {
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
      setAttachmentError(
        t("@connect.composer.attachment.tooLarge", {
          name: oversized.name,
          size: formatBytes(capability.attachments.maxBytesEach, t),
        }),
      );
      return;
    }
    const unsupported = files.find(
      (file) =>
        !capability.attachments.allowedKinds.includes(attachmentKind(file.type) ?? "file") ||
        !mediaTypeAllowed(file.type, capability.attachments.allowedMediaTypes),
    );
    if (unsupported) {
      setAttachmentError(t("@connect.composer.attachment.unsupported", { name: unsupported.name }));
      return;
    }
    setAttachments((current) => {
      const next = [...current, ...files];
      if (next.length > capability.attachments.maxCount) {
        setAttachmentError(t("@connect.composer.attachment.tooMany", { count: capability.attachments.maxCount }));
        return current;
      }
      if (next.reduce((total, file) => total + file.size, 0) > capability.attachments.maxBytesTotal) {
        setAttachmentError(
          t("@connect.composer.attachment.totalTooLarge", {
            size: formatBytes(capability.attachments.maxBytesTotal, t),
          }),
        );
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
            group={
              suggestion?.kind === "skill" ? t("@connect.composer.slash.skills") : t("@connect.composer.slash.commands")
            }
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
      emptySearchResultsText: slashSuggestionsError
        ? t("@connect.composer.slash.loadFailure")
        : t("@connect.composer.slash.noMatches"),
      loadingText: t("@connect.composer.slash.loading"),
      menuLabel: t("@connect.composer.slash.menu"),
    };
  }, [slashSuggestions, slashSuggestionsError, t]);
  const submit = (prompt: string) => {
    if (!send.isPending && (prompt.trim() || attachments.length > 0)) {
      const draft = {
        submissionId: requestId(),
        prompt,
        files: [...attachments],
        selection: selectedSelection,
      };
      setValue("");
      setSelectedSelection(null);
      setAttachments([]);
      setAttachmentError(null);
      send.mutate(draft, {
        onSuccess: (response) => {
          if (response.turnId) setAcceptedTurnId(response.turnId);
          void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) });
        },
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
      if (turn.attachments.length > 0) {
        setAttachmentError(t("@connect.composer.attachment.queueRemoved"));
      }
    }
    withdraw.mutate(
      { turn, restore },
      {
        onError: () => setHiddenQueuedTurnIds((current) => current.filter((turnId) => turnId !== turn.turnId)),
      },
    );
  };
  const visibleQueuedTurns = queuedTurns.filter((turn) => !hiddenQueuedTurnIds.includes(turn.turnId));
  const queueCount = visibleQueuedTurns.length;
  const error = attachmentError ?? stop.error?.message ?? withdraw.error?.message;
  const composerDisabled = !canSend || hasPendingInteraction;
  const composerInputDisabled = composerDisabled || send.isPending;
  const isAgentWorking = Boolean(acceptedTurnId) || isRuntimeActive;
  const hasSubmissionDraft = Boolean(value.trim() || attachments.length > 0);
  const attachmentLimitLabel =
    capability.attachments.maxCount === 0
      ? t("@connect.composer.attachment.notSupported")
      : t("@connect.composer.attachment.limits", {
          count: capability.attachments.maxCount,
          eachSize: formatBytes(capability.attachments.maxBytesEach, t),
          totalSize: formatBytes(capability.attachments.maxBytesTotal, t),
        });
  return (
    <div className="composer-region">
      {queueCount > 0 ? (
        <List
          className="composer-queue"
          density="compact"
          hasDividers
          header={t("@connect.composer.queue.header", { count: queueCount })}
        >
          {visibleQueuedTurns.map((turn) => (
            <ListItem
              key={turn.turnId}
              label={turn.prompt || t("@connect.composer.queue.attachmentOnly")}
              description={queuedTurnDescription(turn, t)}
              endContent={
                <ButtonGroup label={t("@connect.composer.queue.actions")} size="sm">
                  <Button
                    label={t("@connect.composer.queue.withdraw")}
                    icon={<Icon icon={RotateCcw} size="sm" />}
                    size="sm"
                    variant="secondary"
                    isLoading={withdraw.isPending && withdraw.variables?.turn.turnId === turn.turnId}
                    onClick={() => withdrawTurn(turn, true)}
                  />
                  <Button
                    label={t("@connect.composer.queue.delete")}
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
            ? t("@connect.composer.placeholder.interaction")
            : canSend
              ? t("@connect.composer.placeholder.ready")
              : t("@connect.composer.placeholder.unavailable")
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
                ? t("@connect.composer.placeholder.interaction")
                : canSend
                  ? t("@connect.composer.placeholder.ready")
                  : t("@connect.composer.placeholder.unavailable")
            }
            label={t("@connect.composer.inputLabel")}
            isDisabled={composerInputDisabled}
          />
        }
        drawer={
          attachments.length > 0 ? (
            <ChatComposerDrawer count={attachments.length} label={t("@connect.composer.attachment.drawerLabel")}>
              <Stack direction="horizontal" gap={1} width="100%" wrap="wrap">
                {attachments.map((file, index) => (
                  <Token
                    key={`${file.name}-${file.size}-${file.lastModified}`}
                    label={file.name}
                    description={t("@connect.composer.attachment.description", {
                      name: file.name,
                      size: formatBytes(file.size, t),
                    })}
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
              label={t("@connect.composer.attachment.upload")}
              tooltip={attachmentLimitLabel}
              icon={<Icon icon={Paperclip} size="sm" />}
              isIconOnly
              size="sm"
              variant="ghost"
              isDisabled={composerInputDisabled || capability.attachments.maxCount === 0}
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
                  <Button
                    label={t("@connect.composer.continueInClawChat")}
                    href={continueInClawChatHref}
                    size="sm"
                    variant="ghost"
                  />
                </span>
                <span className="continue-clawchat-mobile">
                  <Button
                    label={t("@connect.composer.continueInClawChat")}
                    tooltip={t("@connect.composer.continueInClawChat")}
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
          isAgentWorking && !hasSubmissionDraft ? (
            <Button
              label={t("@connect.composer.action.stop")}
              tooltip={t("@connect.composer.action.stopTooltip")}
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
            <ChatSendButton
              isDisabled={composerDisabled || send.isPending || !hasSubmissionDraft}
              onSend={() => submit(value)}
            />
          )
        }
      />
      <VisuallyHidden as="div" aria-live="polite">
        {send.isPending
          ? t("@connect.composer.progress.submitting")
          : isAgentWorking
            ? t("@connect.composer.agentWorking")
            : error || completionAnnouncement}
      </VisuallyHidden>
    </div>
  );
}

function queuedTurnDescription(turn: QueuedTurnView, t: ClientTranslator): string {
  const parts = [turn.selection ? `/${turn.selection.name}` : null];
  if (turn.attachments.length > 0) {
    parts.push(t("@connect.composer.queue.attachmentCount", { count: turn.attachments.length }));
  }
  return parts.filter(Boolean).join(" · ") || t("@connect.composer.queue.waiting");
}

function formatBytes(bytes: number, t: ClientTranslator): string {
  if (bytes < 1024) return t("@connect.composer.size.bytes", { value: bytes });
  if (bytes < 1024 * 1024) return t("@connect.composer.size.kibibytes", { value: bytes / 1024 });
  return t("@connect.composer.size.mebibytes", { value: bytes / (1024 * 1024) });
}

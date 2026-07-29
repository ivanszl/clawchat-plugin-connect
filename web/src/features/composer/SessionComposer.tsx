import { Button } from "@astryxdesign/core/Button";
import { ChatComposer, ChatComposerDrawer, ChatComposerInput, ChatSendButton } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle, Paperclip, Square, X } from "lucide-react";
import { type ReactNode, useEffect, useRef, useState } from "react";
import type { TurnSubmissionCapability } from "../../../../src/client-contract";
import { attachmentKind, mediaTypeAllowed } from "../../../../src/client-interface/turn-submission";
import { cancelTurn, clientKeys } from "../../client-interface/query-options";
import { useTurnSubmission } from "./useTurnSubmission";

export interface SessionComposerProps {
  sessionRef: string;
  contextLabel: string;
  continueInClawChatHref: string | null;
  canSend: boolean;
  isRuntimeActive: boolean;
  capability: TurnSubmissionCapability;
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
  hasPendingInteraction = false,
  modelControl,
}: SessionComposerProps) {
  const queryClient = useQueryClient();
  const storageKey = `connect-client:draft:${sessionRef}`;
  const [value, setValue] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [attachments, setAttachments] = useState<File[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [acceptedTurnId, setAcceptedTurnId] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const next = sessionStorage.getItem(storageKey) ?? "";
    setValue(next);
    setAttachments([]);
    setAttachmentError(null);
    setAcceptedTurnId(null);
  }, [storageKey]);
  useEffect(() => {
    if (!value) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, value);
  }, [storageKey, value]);
  useEffect(() => {
    if (!isRuntimeActive) setAcceptedTurnId(null);
  }, [isRuntimeActive]);
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
  const submit = (prompt: string) => {
    if (!send.isPending && (prompt.trim() || attachments.length > 0)) {
      send.mutate(
        { prompt: prompt.trim(), files: attachments },
        {
          onSuccess: (response) => {
            setValue("");
            setAttachments([]);
            setAttachmentError(null);
            setAcceptedTurnId(response.turnId);
          },
        },
      );
    }
  };
  const stop = useMutation({
    mutationFn: async () => await cancelTurn(sessionRef, acceptedTurnId ?? "active"),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) }),
  });
  const error = attachmentError ?? send.error?.message ?? stop.error?.message;
  const composerDisabled = !canSend || hasPendingInteraction || send.isPending;
  const isAgentWorking = Boolean(acceptedTurnId) || isRuntimeActive;
  const attachmentLimitLabel =
    capability.attachments.maxCount === 0
      ? "当前 Turn Submission 不支持附件"
      : `最多 ${capability.attachments.maxCount} 个附件，单个 ${formatBytes(
          capability.attachments.maxBytesEach,
        )}，合计 ${formatBytes(capability.attachments.maxBytesTotal)}`;
  return (
    <div className="composer-region">
      {send.isPending && send.progress ? (
        <div className="composer-submission-progress" role="status">
          {send.progress.phase === "accepting"
            ? "附件传输完成，正在等待 Session 队列接收"
            : `正在传输 ${formatBytes(send.progress.transferredBytes)} / ${formatBytes(send.progress.totalBytes)}`}
        </div>
      ) : null}
      <ChatComposer
        className="session-composer"
        value={value}
        onChange={setValue}
        onSubmit={submit}
        onStop={() => {
          if (!stop.isPending) stop.mutate();
        }}
        isStopShown={Boolean(acceptedTurnId) || isRuntimeActive}
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
            value={value}
            onChange={setValue}
            onFiles={addFiles}
            onKeyDownCapture={(event) => {
              if (event.key === "Enter" && (event.nativeEvent.isComposing || event.keyCode === 229)) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
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
              <div className="composer-attachments">
                {attachments.map((file, index) => (
                  <div className="composer-attachment" key={`${file.name}-${file.size}-${file.lastModified}`}>
                    <span title={file.name}>{file.name}</span>
                    <Button
                      label={`移除 ${file.name}`}
                      tooltip="移除附件"
                      icon={<Icon icon={X} size="sm" />}
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      onClick={() => setAttachments((current) => current.filter((_, item) => item !== index))}
                    />
                  </div>
                ))}
              </div>
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
              label={send.progress?.phase === "accepting" ? "等待队列接收" : "取消提交"}
              isLoading={send.progress?.phase === "accepting"}
              size="md"
              variant="secondary"
              onClick={send.cancel}
            />
          ) : isAgentWorking ? (
            <div className="composer-working-control">
              <span className="composer-working-indicator">
                <Spinner size="sm" aria-label="Agent 正在工作" />
                正在工作
              </span>
              <Button
                label="停止"
                tooltip="停止当前任务"
                icon={<Icon icon={Square} size="sm" />}
                size="md"
                variant="secondary"
                isLoading={stop.isPending}
                isDisabled={stop.isPending}
                onClick={() => stop.mutate()}
              />
            </div>
          ) : (
            <ChatSendButton
              isDisabled={composerDisabled || (!value.trim() && attachments.length === 0)}
              onSend={() => submit(value)}
            />
          )
        }
      />
      <div className="sr-only" aria-live="polite">
        {send.isPending
          ? send.progress?.phase === "accepting"
            ? "附件传输完成，正在等待 Session 队列接收"
            : `正在传输 ${send.progress?.transferredBytes ?? 0} / ${send.progress?.totalBytes ?? 0} 字节`
          : isAgentWorking
            ? "Agent 正在工作，可以点击停止"
            : ""}
      </div>
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

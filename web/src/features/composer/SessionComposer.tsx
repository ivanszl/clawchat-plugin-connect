import { Button } from "@astryxdesign/core/Button";
import { ChatComposer } from "@astryxdesign/core/Chat";
import { Icon } from "@astryxdesign/core/Icon";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { MessageCircle } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cancelTurn, clientKeys, startTurn } from "../../client-interface/query-options";

export interface SessionComposerProps {
  sessionRef: string;
  contextLabel: string;
  continueInClawChatHref: string | null;
  canSend: boolean;
  isRuntimeActive: boolean;
  hasPendingInteraction?: boolean;
  modelControl?: ReactNode;
}

export function SessionComposer({
  sessionRef,
  contextLabel,
  continueInClawChatHref,
  canSend,
  isRuntimeActive,
  hasPendingInteraction = false,
  modelControl,
}: SessionComposerProps) {
  const queryClient = useQueryClient();
  const storageKey = `connect-client:draft:${sessionRef}`;
  const [value, setValue] = useState(() => sessionStorage.getItem(storageKey) ?? "");
  const [acceptedTurnId, setAcceptedTurnId] = useState<string | null>(null);
  useEffect(() => {
    const next = sessionStorage.getItem(storageKey) ?? "";
    setValue(next);
    setAcceptedTurnId(null);
  }, [storageKey]);
  useEffect(() => {
    if (!value) sessionStorage.removeItem(storageKey);
    else sessionStorage.setItem(storageKey, value);
  }, [storageKey, value]);
  useEffect(() => {
    if (!isRuntimeActive) setAcceptedTurnId(null);
  }, [isRuntimeActive]);

  const send = useMutation({
    mutationFn: async (prompt: string) => await startTurn(sessionRef, prompt),
    onSuccess: (response) => {
      setValue("");
      setAcceptedTurnId(response.turnId);
      void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) });
      void queryClient.invalidateQueries({ queryKey: clientKeys.catalog });
    },
  });
  const stop = useMutation({
    mutationFn: async () => await cancelTurn(sessionRef, acceptedTurnId ?? "active"),
    onSettled: () => void queryClient.invalidateQueries({ queryKey: clientKeys.session(sessionRef) }),
  });
  const error = send.error ?? stop.error;
  return (
    <div className="composer-region">
      <ChatComposer
        className="session-composer"
        value={value}
        onChange={setValue}
        onSubmit={(prompt) => {
          if (!send.isPending && prompt.trim()) send.mutate(prompt);
        }}
        onStop={() => {
          if (!stop.isPending) stop.mutate();
        }}
        isStopShown={Boolean(acceptedTurnId) || isRuntimeActive}
        isDisabled={!canSend || hasPendingInteraction || send.isPending}
        placeholder={
          hasPendingInteraction
            ? "请先完成上方审批或回答"
            : canSend
              ? "给 Agent 发送消息…"
              : "当前 Session 不可发送消息"
        }
        status={error ? { type: "error", message: error.message } : undefined}
        density="balanced"
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
      />
      <div className="sr-only" aria-live="polite">
        {send.isPending ? "消息正在提交" : acceptedTurnId ? "Agent 正在处理" : ""}
      </div>
    </div>
  );
}

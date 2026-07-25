import { ChatComposer } from "@astryxdesign/core/Chat";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type ReactNode, useEffect, useState } from "react";
import { cancelTurn, clientKeys, startTurn } from "../../client-interface/query-options";

export interface SessionComposerProps {
  sessionRef: string;
  canSend: boolean;
  isRuntimeActive: boolean;
  modelControl?: ReactNode;
}

export function SessionComposer({ sessionRef, canSend, isRuntimeActive, modelControl }: SessionComposerProps) {
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
        value={value}
        onChange={setValue}
        onSubmit={(prompt) => {
          if (!send.isPending && prompt.trim()) send.mutate(prompt);
        }}
        onStop={() => {
          if (!stop.isPending) stop.mutate();
        }}
        isStopShown={Boolean(acceptedTurnId) || isRuntimeActive}
        isDisabled={!canSend || send.isPending}
        placeholder={canSend ? "给 Agent 发送消息…" : "当前 Session 不可发送消息"}
        status={error ? { type: "error", message: error.message } : undefined}
        density="balanced"
        footerActions={<span className="composer-note">仅发送到 Connect · 不同步至 ClawChat</span>}
        sendActions={modelControl}
      />
      <div className="sr-only" aria-live="polite">
        {send.isPending ? "消息正在提交" : acceptedTurnId ? "Agent 正在处理" : ""}
      </div>
    </div>
  );
}

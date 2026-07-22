import { AlertDialog } from "@astryxdesign/core/AlertDialog";
import { Badge } from "@astryxdesign/core/Badge";
import { Banner } from "@astryxdesign/core/Banner";
import { DropdownMenu } from "@astryxdesign/core/DropdownMenu";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
  archiveSession,
  catalogQueryOptions,
  clientKeys,
  deleteSession,
  sessionQueryOptions,
  transcriptQueryOptions,
  unarchiveSession,
} from "../client-interface/query-options";
import { MoreIcon } from "../components/icons";
import { SessionComposer } from "../features/composer/SessionComposer";
import { TranscriptViewport } from "../features/transcript/TranscriptViewport";

export const Route = createFileRoute("/sessions/$sessionRef")({ component: SessionPage });

function SessionPage() {
  const { sessionRef } = Route.useParams();
  const session = useQuery(sessionQueryOptions(sessionRef));
  const transcript = useInfiniteQuery(transcriptQueryOptions(sessionRef));
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [deleteOpen, setDeleteOpen] = useState(false);
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
  return (
    <section className="session-page">
      <header className="session-header">
        <div className="session-heading">
          <p className="session-eyebrow">
            {view.workspaceName || view.projectName || "Non-Project"} / {view.sessionRef}
          </p>
          <h1>{view.name}</h1>
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
        {view.transcriptCompleteness !== "complete" ? (
          <Banner
            status="warning"
            title="历史消息可能不完整"
            description="Connect 会继续显示本次运行期间捕获的消息。"
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
        canSend={view.allowedActions.includes("send") && view.status !== "offline"}
        isRuntimeActive={view.status === "running" || view.status === "queued"}
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

function statusLabel(status: "idle" | "running" | "queued" | "offline" | "error"): string {
  return { idle: "空闲", running: "运行中", queued: "排队中", offline: "离线", error: "错误" }[status];
}

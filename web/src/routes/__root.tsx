import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Outlet } from "@tanstack/react-router";
import { useEffect } from "react";
import { connectClientEvents } from "../client-interface/client-events";
import { bootstrapQueryOptions } from "../client-interface/query-options";
import { ConnectAppShell } from "../features/app-shell/ConnectAppShell";

export const Route = createRootRoute({
  component: ClientRoot,
  notFoundComponent: () => (
    <div className="centered-state">
      <Banner status="warning" title="页面不存在" description="请从左侧选择一个 Session。" />
    </div>
  ),
});

function ClientRoot() {
  const bootstrap = useQuery(bootstrapQueryOptions);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!bootstrap.data) return;
    return connectClientEvents(queryClient, bootstrap.data.eventCursor);
  }, [bootstrap.data, queryClient]);

  if (bootstrap.isPending) {
    return (
      <main className="boot-state">
        <Spinner label="正在连接 Connect Service" />
      </main>
    );
  }
  if (bootstrap.isError) {
    return (
      <main className="boot-state">
        <Banner status="error" title="无法连接 Connect Service" description={bootstrap.error.message} />
      </main>
    );
  }
  return (
    <ConnectAppShell>
      <Outlet />
    </ConnectAppShell>
  );
}

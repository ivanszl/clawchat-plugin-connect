import { Banner } from "@astryxdesign/core/Banner";
import { Spinner } from "@astryxdesign/core/Spinner";
import { VStack } from "@astryxdesign/core/Stack";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createRootRoute, Outlet, retainSearchParams } from "@tanstack/react-router";
import { useEffect } from "react";
import { ClientExtensionKernel } from "../client-extensions/ClientExtensionKernel";
import { connectClientEvents } from "../client-interface/client-events";
import { bootstrapQueryOptions } from "../client-interface/query-options";
import { ConnectAppShell } from "../features/app-shell/ConnectAppShell";
import { localizedClientError, useClientTranslator } from "../i18n/client-i18n";
import { canonicalClientLocale } from "../i18n/client-locale";

export const Route = createRootRoute({
  validateSearch: (search: Record<string, unknown>): { lang?: string } => {
    const lang = search.lang;
    return canonicalClientLocale(lang) ? { lang: lang as string } : {};
  },
  search: { middlewares: [retainSearchParams(["lang"])] },
  component: ClientRoot,
  notFoundComponent: ClientNotFound,
});

function ClientNotFound() {
  const t = useClientTranslator();
  return (
    <VStack className="centered-state" align="center" justify="center">
      <Banner status="warning" title={t("@connect.notFound.title")} description={t("@connect.notFound.description")} />
    </VStack>
  );
}

function ClientRoot() {
  const t = useClientTranslator();
  const bootstrap = useQuery(bootstrapQueryOptions);
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!bootstrap.data) return;
    return connectClientEvents(queryClient, bootstrap.data.eventCursor);
  }, [bootstrap.data, queryClient]);

  if (bootstrap.isPending) {
    return (
      <main className="boot-state">
        <Spinner label={t("@connect.startup.loading")} />
      </main>
    );
  }
  if (bootstrap.isError) {
    return (
      <main className="boot-state">
        <Banner
          status="error"
          title={t("@connect.startup.failure.title")}
          description={localizedClientError(t, bootstrap.error)}
        />
      </main>
    );
  }
  return (
    <ClientExtensionKernel graph={bootstrap.data.clientExtensions}>
      <ConnectAppShell>
        <Outlet />
      </ConnectAppShell>
    </ClientExtensionKernel>
  );
}

import "@astryxdesign/core/reset.css";
import "@astryxdesign/core/astryx.css";
import "@astryxdesign/theme-neutral/theme.css";
import "./styles/index.css";

import { Theme } from "@astryxdesign/core";
import { LayerProvider } from "@astryxdesign/core/Layer";
import { neutralTheme } from "@astryxdesign/theme-neutral/built";
import { QueryClientProvider } from "@tanstack/react-query";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { queryClient } from "./app/query-client";
import { UnsupportedBrowser, unsupportedBrowserReason } from "./components/UnsupportedBrowser";
import { ClientInternationalizationProvider } from "./i18n/client-i18n";
import { resolveClientLocale } from "./i18n/client-locale";
import { routeTree } from "./routeTree.gen";

const clientLocale = resolveClientLocale(new URLSearchParams(window.location.search).get("lang"), navigator.languages);
document.documentElement.lang = clientLocale;
const router = createRouter({ routeTree, defaultPreload: "intent", scrollRestoration: false });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const root = document.getElementById("root");
if (!root) throw new Error("Connect Client root element is missing");
const unsupported = unsupportedBrowserReason();
createRoot(root).render(
  <StrictMode>
    <ClientInternationalizationProvider locale={clientLocale}>
      <Theme theme={neutralTheme} mode="system">
        <LayerProvider>
          {unsupported ? (
            <UnsupportedBrowser reason={unsupported} />
          ) : (
            <QueryClientProvider client={queryClient}>
              <RouterProvider router={router} />
            </QueryClientProvider>
          )}
        </LayerProvider>
      </Theme>
    </ClientInternationalizationProvider>
  </StrictMode>,
);

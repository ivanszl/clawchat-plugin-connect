import type { Catalog } from "@astryxdesign/core/i18n";

export const en = {
  "@astryx.appShell.mobileNavigation": { defaultMessage: "Mobile navigation" },
  "@astryx.appShell.skipToContent": { defaultMessage: "Skip to content" },
  "@astryx.mobileNav.toggle.open": { defaultMessage: "Open navigation" },
  "@astryx.mobileNav.navigation": { defaultMessage: "Navigation" },
  "@astryx.mobileNav.closeNavigation": { defaultMessage: "Close navigation" },
  "@astryx.sideNav.label": { defaultMessage: "Side navigation" },
  "@astryx.sideNav.resizeSidebar": { defaultMessage: "Resize sidebar" },
  "@astryx.sideNav.heading.openMenu": { defaultMessage: "Open menu" },
  "@astryx.sideNav.heading.dialogLabel": { defaultMessage: "Navigation menu" },
  "@astryx.sideNavCollapseButton.expandSidebar": { defaultMessage: "Expand sidebar" },
  "@astryx.sideNavCollapseButton.collapseSidebar": { defaultMessage: "Collapse sidebar" },
  "@astryx.treeList.toggleChildren": { defaultMessage: "Toggle children" },
  "@astryx.topNav.heading.openMenu": { defaultMessage: "Open menu" },
  "@astryx.topNav.heading.dialogLabel": { defaultMessage: "Navigation menu" },
  "@astryx.topNav.landmarkLabel": { defaultMessage: "Top navigation" },
  "@astryx.textInput.clearLabel": { defaultMessage: "Clear {label}" },
  "@astryx.toast.viewport": { defaultMessage: "Notifications" },
  "@connect.startup.loading": { defaultMessage: "Connecting to Connect Service" },
  "@connect.startup.failure.title": { defaultMessage: "Unable to connect to Connect Service" },
  "@connect.notFound.title": { defaultMessage: "Page not found" },
  "@connect.notFound.description": { defaultMessage: "Select a Session from the left." },
  "@connect.unsupported.sse": { defaultMessage: "This browser does not support Server-Sent Events." },
  "@connect.unsupported.resizeObserver": {
    defaultMessage: "This browser does not support dynamic message measurement.",
  },
  "@connect.unsupported.randomUuid": { defaultMessage: "This browser cannot create secure request identifiers." },
  "@connect.unsupported.title": { defaultMessage: "Connect Client cannot run" },
  "@connect.unsupported.description": {
    defaultMessage: "{reason} Upgrade to the latest version of Chrome, Edge, Firefox, or Safari.",
  },
  "@connect.shell.refresh": { defaultMessage: "Refresh all Sessions" },
  "@connect.shell.settings": { defaultMessage: "Settings" },
  "@connect.shell.backToSessions": { defaultMessage: "Back to Sessions" },
  "@connect.home.title": { defaultMessage: "Select a Session" },
  "@connect.home.description": {
    defaultMessage: "The left side lists every Project and Non-Project Session discoverable by this Connect binding.",
  },
  "@connect.home.note": {
    defaultMessage: "Web messages only go to the Agent in this Connect binding and are not synced back to ClawChat.",
  },
  "@connect.navigation.search.label": { defaultMessage: "Search Sessions" },
  "@connect.navigation.search.placeholder": { defaultMessage: "Search Sessions or Projects" },
  "@connect.navigation.newSession": { defaultMessage: "New Session" },
  "@connect.navigation.loading": { defaultMessage: "Loading Sessions" },
  "@connect.navigation.loadFailure": {
    defaultMessage: "Unable to load Sessions. Connect Service may not be ready.",
  },
  "@connect.navigation.connected": { defaultMessage: "Connected" },
  "@connect.navigation.disconnected": { defaultMessage: "Disconnected" },
  "@connect.navigation.unknownStatus": { defaultMessage: "Status unknown" },
  "@connect.navigation.noMatches": { defaultMessage: "No matching Sessions" },
  "@connect.navigation.archived": { defaultMessage: "Archived" },
  "@connect.navigation.unnamedWorkspace": { defaultMessage: "Unnamed workspace" },
  "@connect.navigation.status.running": { defaultMessage: "Running" },
  "@connect.navigation.status.queued": { defaultMessage: "Queued" },
  "@connect.navigation.status.error": { defaultMessage: "Error" },
} as const satisfies Catalog;

export type ClientMessageKey = keyof typeof en;
export type ClientCatalog = Record<ClientMessageKey, { defaultMessage: string; description?: string }>;

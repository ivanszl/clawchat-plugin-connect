import type { ClientCatalog } from "./en";

export const es = {
  "@astryx.appShell.mobileNavigation": { defaultMessage: "Navegación móvil" },
  "@astryx.appShell.skipToContent": { defaultMessage: "Saltar al contenido" },
  "@astryx.mobileNav.toggle.open": { defaultMessage: "Abrir navegación" },
  "@astryx.mobileNav.navigation": { defaultMessage: "Navegación" },
  "@astryx.mobileNav.closeNavigation": { defaultMessage: "Cerrar navegación" },
  "@astryx.sideNav.label": { defaultMessage: "Navegación lateral" },
  "@astryx.sideNav.resizeSidebar": { defaultMessage: "Cambiar tamaño de la barra lateral" },
  "@astryx.sideNav.heading.openMenu": { defaultMessage: "Abrir menú" },
  "@astryx.sideNav.heading.dialogLabel": { defaultMessage: "Menú de navegación" },
  "@astryx.sideNavCollapseButton.expandSidebar": { defaultMessage: "Expandir barra lateral" },
  "@astryx.sideNavCollapseButton.collapseSidebar": { defaultMessage: "Contraer barra lateral" },
  "@astryx.treeList.toggleChildren": { defaultMessage: "Mostrar u ocultar elementos secundarios" },
  "@astryx.topNav.heading.openMenu": { defaultMessage: "Abrir menú" },
  "@astryx.topNav.heading.dialogLabel": { defaultMessage: "Menú de navegación" },
  "@astryx.topNav.landmarkLabel": { defaultMessage: "Navegación superior" },
  "@astryx.textInput.clearLabel": { defaultMessage: "Borrar {label}" },
  "@astryx.toast.viewport": { defaultMessage: "Notificaciones" },
  "@connect.startup.loading": { defaultMessage: "Conectando con Connect Service" },
  "@connect.startup.failure.title": { defaultMessage: "No se puede conectar con Connect Service" },
  "@connect.notFound.title": { defaultMessage: "Página no encontrada" },
  "@connect.notFound.description": { defaultMessage: "Selecciona una Session a la izquierda." },
  "@connect.unsupported.sse": { defaultMessage: "Este navegador no admite Server-Sent Events." },
  "@connect.unsupported.resizeObserver": {
    defaultMessage: "Este navegador no permite medir mensajes de forma dinámica.",
  },
  "@connect.unsupported.randomUuid": {
    defaultMessage: "Este navegador no puede crear identificadores de solicitud seguros.",
  },
  "@connect.unsupported.title": { defaultMessage: "Connect Client no se puede ejecutar" },
  "@connect.unsupported.description": {
    defaultMessage: "{reason} Actualiza Chrome, Edge, Firefox o Safari a la versión más reciente.",
  },
  "@connect.shell.refresh": { defaultMessage: "Actualizar todas las Sessions" },
  "@connect.shell.settings": { defaultMessage: "Configuración" },
  "@connect.shell.backToSessions": { defaultMessage: "Volver a Sessions" },
  "@connect.home.title": { defaultMessage: "Selecciona una Session" },
  "@connect.home.description": {
    defaultMessage:
      "A la izquierda aparecen todos los Projects y las Non-Project Sessions que puede detectar este vínculo de Connect.",
  },
  "@connect.home.note": {
    defaultMessage:
      "Los mensajes web solo se envían al Agent de este vínculo de Connect y no se sincronizan con ClawChat.",
  },
  "@connect.navigation.search.label": { defaultMessage: "Buscar Sessions" },
  "@connect.navigation.search.placeholder": { defaultMessage: "Buscar Sessions o Projects" },
  "@connect.navigation.newSession": { defaultMessage: "Nueva Session" },
  "@connect.navigation.loading": { defaultMessage: "Cargando Sessions" },
  "@connect.navigation.loadFailure": {
    defaultMessage: "No se pueden cargar las Sessions. Es posible que Connect Service aún no esté listo.",
  },
  "@connect.navigation.connected": { defaultMessage: "Conectado" },
  "@connect.navigation.disconnected": { defaultMessage: "Desconectado" },
  "@connect.navigation.unknownStatus": { defaultMessage: "Estado desconocido" },
  "@connect.navigation.noMatches": { defaultMessage: "No hay Sessions coincidentes" },
  "@connect.navigation.archived": { defaultMessage: "Archivadas" },
  "@connect.navigation.unnamedWorkspace": { defaultMessage: "Espacio de trabajo sin nombre" },
  "@connect.navigation.status.running": { defaultMessage: "En ejecución" },
  "@connect.navigation.status.queued": { defaultMessage: "En cola" },
  "@connect.navigation.status.error": { defaultMessage: "Error" },
} satisfies ClientCatalog;

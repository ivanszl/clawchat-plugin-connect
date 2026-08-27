import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "web",
  plugins: [
    tanstackRouter({
      target: "react",
      routesDirectory: "./src/routes",
      generatedRouteTree: "./src/routeTree.gen.ts",
      quoteStyle: "double",
      semicolons: true,
      autoCodeSplitting: true,
    }),
    react(),
  ],
  build: {
    outDir: "../dist/client",
    emptyOutDir: true,
    sourcemap: false,
    manifest: "asset-manifest.json",
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/client": "http://127.0.0.1:47823",
    },
  },
});

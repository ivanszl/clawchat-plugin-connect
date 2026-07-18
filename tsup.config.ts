import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/bin.ts"],
  format: ["esm"],
  platform: "node",
  target: "node20",
  outDir: "dist/src",
  clean: true,
  dts: true,
  splitting: true,
  sourcemap: true,
});

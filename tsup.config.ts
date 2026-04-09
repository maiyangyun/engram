import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: false,
  sourcemap: true,
  clean: true,
  external: ["openclaw/plugin-sdk/plugin-entry", "@sinclair/typebox", "better-sqlite3"],
  platform: "node",
  target: "node22",
});

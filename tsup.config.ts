import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/cli/generate.ts", "src/cli/lint.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  splitting: false,
  sourcemap: false,
  dts: false,
  shims: true,
});

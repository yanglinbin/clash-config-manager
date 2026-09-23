import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    env: { LOG_LEVEL: "ERROR" },
    include: ["tests/**/*.test.ts"],
  },
});

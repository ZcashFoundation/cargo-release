import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      exclude: ["src/main.ts"],
      thresholds: {
        branches: 80,
        functions: 95,
        lines: 90,
        statements: 85,
      },
    },
  },
});

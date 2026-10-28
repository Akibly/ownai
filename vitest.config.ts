import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["apps/*/test/**/*.test.ts", "packages/*/test/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});

import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "docker/**/*.test.mjs"],
    exclude: ["test/integration/**", "node_modules/**"],
    testTimeout: 20_000,
    hookTimeout: 90_000,
  },
});

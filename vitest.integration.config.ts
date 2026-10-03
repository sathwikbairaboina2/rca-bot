import { defineConfig } from "vitest/config";
export default defineConfig({ test: { include: ["test/integration/**/*.int.test.ts"], testTimeout: 120_000 } });

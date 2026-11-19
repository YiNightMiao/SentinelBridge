import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    fileParallelism: false, // Shared integration-test DB is reset between test suites.
    testTimeout: 30000,
    hookTimeout: 30000,
  },
});

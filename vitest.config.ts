import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    testTimeout: 0,
    hookTimeout: 0,
    include: ["test/**/*.spec.ts"],
  },
});

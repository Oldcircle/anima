import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    exclude: ["**/*.live.test.ts", "**/*.sim.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.sim.test.ts"],
    testTimeout: 300_000,
    hookTimeout: 300_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 2 } },
  },
});

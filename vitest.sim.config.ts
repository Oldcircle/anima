import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.sim.test.ts"],
    testTimeout: 900_000,
    hookTimeout: 900_000,
    pool: "forks",
    poolOptions: { forks: { maxForks: 2 } },
    reporters: ["verbose"],
  },
});

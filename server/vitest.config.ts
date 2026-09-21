import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Runs before every test module, so config.ts sees the sandboxed home.
    setupFiles: ["./src/testing/setup.ts"],
    // These tests spawn real child processes and share process-wide env vars
    // (PI_WEB_SIMPLE_HOME, STUB_SESSION_FILE); one fork keeps them serialized.
    pool: "forks",
    poolOptions: {
      forks: { singleFork: true },
    },
  },
});

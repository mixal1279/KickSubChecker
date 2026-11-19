import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: {
        configPath: "./wrangler.do-test.toml",
      },
    }),
  ],
  test: {
    include: ["test/*.vitest.js"],
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});

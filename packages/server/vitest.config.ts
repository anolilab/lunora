import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

/**
 * The shared config, plus — under `LUNORA_WORKERD_TESTS=1` (see
 * `packages/do/vitest.config.ts` for why the gate exists) — a `workerd` project
 * that binds `ctx.services` to real sibling Workers (`__tests__/workerd/`).
 * The ungated path is the shared helper unchanged, so coverage and its
 * thresholds still apply to every Node run.
 */
const runWorkerd = process.env.LUNORA_WORKERD_TESTS === "1";

export default runWorkerd
    ? defineConfig({
          test: {
              projects: [
                  { extends: true, test: { environment: "node", exclude: ["__tests__/workerd/**"], include: ["__tests__/**/*.test.ts"], name: "node" } },
                  {
                      extends: true,
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              miniflare: {
                                  workers: [
                                      {
                                          compatibilityDate: "2026-04-07",
                                          modules: true,
                                          name: "parser",
                                          script: `export default { async fetch(request) { return new Response("parsed " + new URL(request.url).pathname); } };`,
                                      },
                                      {
                                          compatibilityDate: "2026-04-07",
                                          modules: true,
                                          name: "gateway",
                                          script: `import { WorkerEntrypoint } from "cloudflare:workers";
export class Gateway extends WorkerEntrypoint { async complete(prompt) { return "completed " + prompt; } fetch(request) { return new Response("gateway " + new URL(request.url).pathname); } }
export default { fetch: () => new Response("gateway") };`,
                                      },
                                  ],
                              },
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                          }),
                      ],
                      test: { include: ["__tests__/workerd/**/*.test.ts"], name: "workerd" },
                  },
              ],
          },
      })
    : getVitestConfig({ test: { environment: "node", exclude: ["__tests__/workerd/**"] } });

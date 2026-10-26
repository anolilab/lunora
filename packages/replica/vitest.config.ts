import { randomBytes } from "node:crypto";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { configDefaults, defineConfig } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

const base = getVitestConfig({ test: { environment: "node" } }, { branches: 88, functions: 98, lines: 96, statements: 96 });

// The EventLogDO suite runs in real workerd only when LUNORA_WORKERD_TESTS=1 (the workerd CI job sets it). Without the gate, the
// suite stays out of the Node run, which cannot boot a Durable Object.
const workerdSuite = "__tests__/workerd/**";
const workerdGated = process.env.LUNORA_WORKERD_TESTS === "1";

// Each project spells out its own include and exclude. `extends` would merge the root's default include into the workerd glob, and
// the Node suite would then run inside workerd.
const { exclude: _rootExclude, include: _rootInclude, ...shared } = base.test ?? {};

export default defineConfig({
    ...base,
    test: workerdGated
        ? {
              ...base.test,
              projects: [
                  {
                      test: { ...shared, name: "mocks", include: configDefaults.include, exclude: [...configDefaults.exclude, workerdSuite] },
                  },
                  {
                      plugins: [
                          cloudflareTest({
                              main: "__tests__/workerd/test-worker.ts",
                              wrangler: { configPath: "./__tests__/workerd/wrangler.jsonc" },
                              miniflare: { bindings: { LUNORA_RELAY_SECRET: randomBytes(32).toString("hex") } },
                          }),
                      ],
                      test: { ...shared, name: "workerd", include: ["__tests__/workerd/**/*.test.ts"], exclude: configDefaults.exclude },
                  },
              ],
          }
        : { ...shared, include: configDefaults.include, exclude: [...configDefaults.exclude, workerdSuite] },
});

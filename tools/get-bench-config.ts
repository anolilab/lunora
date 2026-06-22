/// <reference types="vitest" />
import codspeedPlugin from "@codspeed/vitest-plugin";
import type { ViteUserConfig } from "vitest/config";
import { defineConfig } from "vitest/config";

/**
 * Shared Vitest config for benchmark (`vitest bench`) runs.
 *
 * Kept separate from `get-vitest-config` because:
 *
 *  - The CodSpeed plugin must only load on bench runs (under CodSpeed CI it
 *    instruments the benches; locally it is a transparent pass-through).
 *  - Several packages (`@lunora/do`, `@lunora/d1`, `@lunora/runtime`,
 *    `@lunora/scheduler`) drive their main suite through the Cloudflare
 *    `vitest-pool-workers` and/or a `projects` config whose `include` is scoped
 *    to `__tests__/`. Benches must run in plain Node — workerd can't boot in CI
 *    — so they get this dedicated, pool-free config instead.
 *
 * `benchmark.include` covers both `.bench.ts` and `.bench.tsx` (mail renders
 * React Email templates), and JSX is compiled with the automatic runtime so
 * `.tsx` benches need no explicit `React` import.
 */
export const getBenchConfig = (options: ViteUserConfig = {}) =>
    defineConfig({
        ...options,
        esbuild: {
            jsx: "automatic",
            jsxImportSource: "react",
            ...options.esbuild,
        },
        plugins: [codspeedPlugin(), ...(options.plugins ?? [])],
        test: {
            environment: "node",
            // CodSpeed instruments benches under cachegrind (~50-100x slower than
            // a normal run), so `beforeAll` seeding that finishes in well under a
            // second locally blows past Vitest's default 10s hook timeout in CI —
            // surfacing as "Hook timed out in 10000ms" and, when the seed never
            // lands, downstream "document not found" errors in patch/replace
            // benches. Give the hooks (and the bench bodies) a generous ceiling.
            hookTimeout: 300_000,
            testTimeout: 300_000,
            ...options.test,
            benchmark: {
                include: ["__bench__/**/*.bench.{ts,tsx}"],
                ...options.test?.benchmark,
            },
        },
    });

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { lunora, resolveOverlayOption, VERSION } from "../src/index";
import { lunoraSolutionFinder } from "../src/solution-finders";

let workdir: string;

const SCHEMA = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),
});
`;

/** The same schema plus a `.global()` table, which implies the D1 binding Lunora provisions itself. */
const SCHEMA_WITH_GLOBAL = `import { defineSchema, defineTable, v } from "@lunora/server";

export const schema = defineSchema({
    messages: defineTable({
        channelId: v.id("channels"),
        text: v.string(),
    }).shardBy("channelId"),

    users: defineTable({
        email: v.string(),
    }).global(),
});
`;

const VALID_WRANGLER = `{
    "name": "lunora-app",
    "compatibility_date": "2026-04-07",
    "compatibility_flags": ["web_socket_auto_reply_to_close"],
    "durable_objects": {
        "bindings": [{ "name": "SHARD", "class_name": "ShardDO" }]
    }
}
`;

describe("index", () => {
    beforeEach(() => {
        workdir = mkdtempSync(join(tmpdir(), "lunora-vite-index-"));
        mkdirSync(join(workdir, "lunora"), { recursive: true });
        writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA, "utf8");
        writeFileSync(join(workdir, "wrangler.jsonc"), VALID_WRANGLER, "utf8");
    });

    afterEach(() => {
        rmSync(workdir, { force: true, recursive: true });
    });

    describe("lunora()", () => {
        it("returns an array of plugins including the lunora internals and cloudflare", async () => {
            expect.hasAssertions();

            const plugins = lunora({ overlay: false, projectRoot: workdir, validateWrangler: true });

            expect(Array.isArray(plugins)).toBe(true);

            const names = plugins.map((plugin) => plugin.name);

            expect(names).toContain("lunora:codegen");
            expect(names).toContain("lunora:wrangler-validator");
            // The cloudflare plugin contributes at least one plugin to the array.
            expect(names.some((name) => name.includes("cloudflare"))).toBe(true);
        });

        it("excludes the cloudflare plugin when cloudflare is false", async () => {
            expect.hasAssertions();

            const plugins = lunora({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

            const names = plugins.map((plugin) => plugin.name);

            expect(names).toContain("lunora:codegen");
            expect(names.some((name) => name.includes("cloudflare"))).toBe(false);
        });

        it("keeps the host-independent dev plugins on the BYO path", async () => {
            expect.hasAssertions();

            // `cloudflare: false` says only that the PROJECT adds the Cloudflare
            // plugin (the shipped vinext default) — it still runs a dev worker and
            // its containers. Gating these on the option left that path with no
            // container logs at all.
            const plugins = lunora({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

            expect(plugins.map((plugin) => plugin.name)).toContain("lunora:container-logs");
        });

        it("excludes the wrangler validator when validateWrangler is false", async () => {
            expect.hasAssertions();

            const plugins = lunora({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

            const names = plugins.map((plugin) => plugin.name);

            expect(names).not.toContain("lunora:wrangler-validator");
        });

        it("provisions the bindings the schema implies even when validateWrangler is false", async () => {
            expect.assertions(2);

            // Provisioning is not validation: `@cloudflare/vite-plugin` parses
            // `wrangler.jsonc` in its own `config` hook and builds the miniflare
            // worker from that parsed object, so a binding written later never
            // reaches the worker that boots. Registering the reconcile with the
            // validator meant `validateWrangler: false` — an option whose name
            // promises only that checks are skipped — brought back the exact
            // missing-`env.DB` boot this fixed.
            writeFileSync(join(workdir, "lunora", "schema.ts"), SCHEMA_WITH_GLOBAL, "utf8");

            const plugins = lunora({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

            expect(plugins.map((plugin) => plugin.name)).toContain("lunora:bindings-provision");

            for (const plugin of plugins) {
                const hook = plugin.config;
                const run = typeof hook === "function" ? hook : hook?.handler;

                // eslint-disable-next-line no-await-in-loop -- Vite runs `config` hooks in registration order, one at a time
                await run?.call({} as never, {} as never, { command: "serve", mode: "development" } as never);
            }

            expect(readFileSync(join(workdir, "wrangler.jsonc"), "utf8")).toMatch(/d1_databases/u);
        });

        it("includes the overlay plugin when overlay is true", async () => {
            expect.assertions(1);

            const plugins = lunora({ cloudflare: false, overlay: true, projectRoot: workdir, validateWrangler: false });

            // Either the real overlay (whatever name it carries) or our no-op injector
            // should be present — but the array length must be strictly greater than the
            // codegen-only case.
            const minimal = lunora({ cloudflare: false, overlay: false, projectRoot: workdir, validateWrangler: false });

            expect(plugins.length).toBeGreaterThan(minimal.length);
        });
    });

    describe("vERSION", () => {
        it("reflects the real package.json version, not the old hardcoded 0.0.0", () => {
            expect.assertions(2);

            const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

            expect(VERSION).not.toBe("0.0.0");
            expect(VERSION).toBe(manifest.version);
        });
    });

    describe("resolveOverlayOption", () => {
        const userFinder = { handle: async () => undefined, name: "user", priority: 100 };

        it("returns false when overlay is disabled", () => {
            expect.assertions(1);

            expect(resolveOverlayOption(false)).toBe(false);
        });

        it("injects Lunora's finders for the default (true/undefined) overlay", () => {
            expect.assertions(2);

            for (const overlay of [true, undefined] as const) {
                const resolved = resolveOverlayOption(overlay);

                expect(resolved === false ? [] : resolved.solutionFinders).toContain(lunoraSolutionFinder);
            }
        });

        it("prepends Lunora's finders before a user's, keeping both", () => {
            expect.assertions(3);

            const resolved = resolveOverlayOption({ solutionFinders: [userFinder] });
            const finders = resolved === false ? [] : (resolved.solutionFinders ?? []);

            expect(finders).toHaveLength(2);
            // Lunora is first, so at an equal priority it wins the overlay's stable
            // sort — a user must use a strictly higher priority to outrank it.
            expect(finders[0]).toBe(lunoraSolutionFinder);
            expect(finders[1]).toBe(userFinder);
        });

        it("defaults forwardedConsoleMethods but lets a partial user object override it", () => {
            expect.assertions(2);

            const defaulted = resolveOverlayOption({ solutionFinders: [] });
            const overridden = resolveOverlayOption({ forwardedConsoleMethods: ["error"] });

            expect(defaulted === false ? undefined : defaulted.forwardedConsoleMethods).toStrictEqual(["error", "warn"]);
            expect(overridden === false ? undefined : overridden.forwardedConsoleMethods).toStrictEqual(["error"]);
        });

        it("keeps the default when the user explicitly passes an undefined forwardedConsoleMethods", () => {
            expect.assertions(1);

            // An explicit `undefined` must not erase the default via the spread.
            const resolved = resolveOverlayOption({ forwardedConsoleMethods: undefined });

            expect(resolved === false ? undefined : resolved.forwardedConsoleMethods).toStrictEqual(["error", "warn"]);
        });
    });
});

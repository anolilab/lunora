import { describe, expect, it } from "vitest";

import type { WranglerConfigShape } from "../src/cloudflare/wrangler-to-alchemy";
import { wranglerToAlchemy } from "../src/cloudflare/wrangler-to-alchemy";

const BASE: WranglerConfigShape = { main: "src/server/index.ts", name: "my-app" };

describe("wranglerToAlchemy", () => {
    it("emits a runnable program for a config with no bindings", () => {
        expect.assertions(4);

        const { source, unsupported } = wranglerToAlchemy(BASE);

        expect(source).toContain(`import alchemy from "alchemy";`);
        expect(source).toContain(`const app = await alchemy("my-app");`);
        expect(source).toContain("await app.finalize();");
        expect(unsupported).toStrictEqual([]);
    });

    it("adopts existing resources rather than creating alongside them", () => {
        expect.assertions(2);

        const { source } = wranglerToAlchemy({
            ...BASE,
            d1_databases: [{ binding: "DB", database_id: "abc123", database_name: "my-app-db" }],
        });

        // The single most important flag here. A project translated from an
        // existing `wrangler.jsonc` already HAS its database, with data in it.
        // Without adoption Alchemy treats it as new and creates a second one —
        // the one outcome a deploy must never have.
        expect(source).toContain(`await D1Database("DB", { adopt: true, name: "my-app-db" });`);

        // `database_id` is Cloudflare's handle, not an Alchemy input — adoption
        // matches on the name.
        expect(source).not.toContain("abc123");
    });

    it("marks a Durable Object as SQLite-backed from any migration entry, not just the newest", () => {
        expect.assertions(2);

        const { source } = wranglerToAlchemy({
            ...BASE,
            durable_objects: {
                bindings: [
                    { class_name: "ShardDO", name: "SHARD" },
                    { class_name: "PlainDO", name: "PLAIN" },
                ],
            },
            migrations: [{ new_sqlite_classes: ["ShardDO"] }, { new_classes: ["PlainDO"] }],
        });

        // A class introduced in `v1` is still SQLite-backed at `v3`, so the flag
        // is accumulated across migrations rather than read off the last one.
        expect(source).toContain(`DurableObjectNamespace("SHARD", { className: "ShardDO", sqlite: true })`);
        expect(source).toContain(`DurableObjectNamespace("PLAIN", { className: "PlainDO", sqlite: false })`);
    });

    it("reports what it could not carry over instead of dropping it silently", () => {
        expect.assertions(2);

        const { source, unsupported } = wranglerToAlchemy({
            ...BASE,
            vectorize: [{ binding: "POSTS_SEARCH", index_name: "posts_search" }],
        } as WranglerConfigShape);

        // A silently-dropped Vectorize binding produces a worker whose
        // `env.POSTS_SEARCH` is undefined at runtime, with nothing in the build
        // to explain it. The caller has to be able to say so.
        expect(unsupported).toContain("vectorize");
        expect(source).not.toContain("POSTS_SEARCH");
    });

    it("reports every binding kind it cannot model, not just the ones with a top-level array", () => {
        expect.assertions(1);

        // `queues.consumers`, `services`, `secrets_store_secrets`, `send_email`,
        // `assets`, `flagship` and `tail_consumers` were all absent from the
        // report while being just as dropped as `vectorize` — so a translated
        // deploy lost the queue consumer, the service binding and the secret
        // store with nothing in the build saying why. Lunora writes every one of
        // these into `wrangler.jsonc` itself.
        const { unsupported } = wranglerToAlchemy({
            ...BASE,
            assets: { directory: "./public" },
            flagship: [{ app_id: "app-abc", binding: "FLAGS" }],
            queues: { consumers: [{ queue: "jobs" }], producers: [{ binding: "JOBS", queue: "jobs" }] },
            secrets_store_secrets: [{ binding: "WALLET_KEY", secret_name: "wallet", store_id: "store-1" }],
            send_email: [{ name: "MAILER" }],
            services: [{ binding: "AUTH", service: "auth-worker" }],
            tail_consumers: [{ service: "logs-worker" }],
        } as WranglerConfigShape);

        expect(unsupported.toSorted((a, b) => a.localeCompare(b))).toStrictEqual([
            "assets",
            "flagship",
            "queues.consumers",
            "secrets_store_secrets",
            "send_email",
            "services",
            "tail_consumers",
        ]);
    });

    it("preserves a var's JSON type instead of stringifying it", () => {
        expect.assertions(3);

        // `literal(String(value))` turned `"MAX": 5` into the string `"5"`, so
        // the deployed worker read a number var as text — a silent type change
        // under a translation whose whole promise is fidelity.
        const { source } = wranglerToAlchemy({ ...BASE, vars: { DEBUG: false, LIMITS: { soft: 1 }, MAX: 5 } });

        expect(source).toContain("MAX: 5,");
        expect(source).toContain("DEBUG: false,");
        expect(source).toContain(`LIMITS: {"soft":1},`);
    });

    it("skips a Durable Object implemented by another worker", () => {
        expect.assertions(2);

        const { source, unsupported } = wranglerToAlchemy({
            ...BASE,
            durable_objects: { bindings: [{ class_name: "OtherDO", name: "OTHER", script_name: "other-worker" }] },
        });

        // The implementing worker is outside this program's scope, so binding to
        // it would reference something the program never creates.
        expect(source).not.toContain("OTHER");
        expect(unsupported[0]).toContain("external script_name");
    });

    it("quotes a binding name that is not a valid identifier", () => {
        expect.assertions(2);

        const { source } = wranglerToAlchemy({ ...BASE, r2_buckets: [{ binding: "my-bucket", bucket_name: "b" }] });

        // Nothing enforces that a binding is `SCREAMING_SNAKE`, and a hyphen
        // would emit a program that does not parse.
        expect(source).toContain(`"my-bucket":`);
        expect(source).toContain("const binding_my_bucket =");
    });

    it("uses shorthand when the binding name is already the local const", () => {
        expect.assertions(1);

        const { source } = wranglerToAlchemy({ ...BASE, r2_buckets: [{ binding: "FILES", bucket_name: "files" }] });

        // The generated file gets read by humans debugging a deploy; `FILES: FILES` is noise.
        expect(source).toContain("        FILES,");
    });

    it("carries crons, compatibility settings and vars onto the worker", () => {
        expect.assertions(4);

        const { source } = wranglerToAlchemy({
            ...BASE,
            compatibility_date: "2026-04-07",
            compatibility_flags: ["nodejs_compat"],
            triggers: { crons: ["0 * * * *"] },
            vars: { PUBLIC_URL: "https://example.com" },
        });

        expect(source).toContain(`compatibilityDate: "2026-04-07",`);
        expect(source).toContain(`compatibilityFlags: ["nodejs_compat"],`);
        expect(source).toContain(`crons: ["0 * * * *"],`);
        expect(source).toContain(`PUBLIC_URL: "https://example.com",`);
    });

    it("omits an empty bindings block rather than emitting an empty object", () => {
        expect.assertions(1);

        expect(wranglerToAlchemy(BASE).source).not.toContain("bindings:");
    });

    it("emits each var binding exactly once (regression: alpha emitted vars twice)", () => {
        expect.assertions(1);

        // Alpha had both an inline `Object.entries(config.vars)` loop and a
        // `collectVariables(config, bindings)` call, so every var landed on the
        // worker twice. The dedupe must not regress — a duplicate binding key is
        // a Worker deploy error.
        const { source } = wranglerToAlchemy({ ...BASE, vars: { PUBLIC_URL: "https://example.com", SECRET_KEY: "s3cr3t" } });

        const countPublicUrl = (source.match(/PUBLIC_URL:/g) ?? []).length;
        const countSecretKey = (source.match(/SECRET_KEY:/g) ?? []).length;

        expect([countPublicUrl, countSecretKey]).toStrictEqual([1, 1]);
    });
});

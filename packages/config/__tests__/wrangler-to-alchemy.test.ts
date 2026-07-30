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
});

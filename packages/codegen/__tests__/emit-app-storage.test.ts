import { describe, expect, it } from "vitest";

import { emitShard } from "../src/emit";
import { emitApp } from "../src/emit-app";

/** Minimal `EmitAppOptions` with every capability off; tests flip one flag at a time. */
const baseOptions = {
    hasAccess: false,
    hasAi: false,
    hasAnalytics: false,
    hasAuth: false,
    hasBrowser: false,
    hasFramework: false,
    hasGlobal: false,
    hasHyperdrive: false,
    hasHyperdriveGlobal: false,
    hasImages: false,
    hasKv: false,
    hasKvIntrospector: false,
    hasNotify: false,
    hasPayments: false,
    hasQueue: false,
    hasR2sql: false,
    hasScheduler: false,
    hasSourcedTables: false,
    hasStorage: true,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tables: [],
    useUmbrella: false,
    wantsOpenApi: false,
    wantsOpenRpc: false,
};

describe("emitApp — storage bucket factory", () => {
    // The DO resolver and the studio admin deriver both build one `Storage` per
    // bucket. They used to carry a copy each of the factory and its `bucketName`
    // rationale — 13 duplicated lines in every user's `_generated/app.ts`, free to
    // drift apart unnoticed. One `makeStorage` method serves both.
    it("emits the bucket factory exactly once", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output.split("createStorage({")).toHaveLength(2);
        expect(output.split("private makeStorage(")).toHaveLength(2);
    });

    it("signs every bucket under the name it is registered as", () => {
        expect.assertions(3);

        const output = emitApp(baseOptions);

        // Default bucket signs as `"default"`; named buckets sign as their key —
        // `bucketName` is bound into the signed-URL HMAC canonical, so a bucket
        // signing under another's name lets a URL cross buckets.
        expect(output).toContain('this.makeStorage(env, declaration, defaultBucket, "default", origin)');
        expect(output).toContain("map[name] = this.makeStorage(env, declaration, bucket, name, origin);");
        expect(output).toContain("return this.makeStorage(env, declaration, bindings[bucketName] ?? defaultBucket, bucketName, origin);");
    });

    // A fixed `publicBaseUrl` binds signed URLs to one host (the HMAC covers it),
    // so a value that is right in dev is wrong on every deploy. Undeclared, the
    // base is the origin the request reached the worker on — on both the shard
    // and the HTTP-action path. A declared one still wins.
    it("falls back to the request origin when no publicBaseUrl is declared", () => {
        expect.assertions(3);

        const output = emitApp(baseOptions);

        expect(output).toContain("publicBaseUrl: declaration.publicBaseUrl?.(env) ?? origin,");
        expect(output).toContain("storage: (rawEnv: Record<string, unknown>, origin?: string) => this.resolveStorage(rawEnv as Env, origin)");
        expect(output).toContain("options.storage = (rawEnv: unknown, origin?: string) => this.resolveStorage(rawEnv as Env, origin);");
    });

    // The studio's "copy URL" and the importer's large-blob PUT go through
    // `storageSignedUrl`. It used to exist only when a `publicBaseUrl` was
    // declared, so an app relying on the origin fallback above lost both. The
    // admin route hands over the origin its request reached the worker on, and
    // the signer uses it when no base is declared; only the secret gates it.
    it("signs studio URLs against the admin request origin when no publicBaseUrl is declared", () => {
        expect.assertions(3);

        const output = emitApp(baseOptions);

        expect(output).toContain("const hasSigning = Boolean(declaration.signingSecret?.(env));");
        expect(output).not.toContain("declaration.publicBaseUrl?.(env) && declaration.signingSecret?.(env)");
        expect(output).toContain("pick(opts?.bucket, opts?.origin).getSignedUrl(");
    });

    // The shard hands the origin only to a synchronous mutation/action dispatch.
    // A query re-runs on subscription refreshes with no request behind it, and
    // the reactive cache does not key on the host, so it must never see one.
    it("hands the request origin to non-query synchronous dispatches only", () => {
        expect.assertions(4);

        const shard = emitShard({ schema: { tables: [], vectorIndexes: [] } });

        expect(shard).toContain('const requestOrigin = contextKind !== "query" && options.identity === undefined ? this.getCurrentOrigin() : undefined;');
        expect(shard).toContain("config.storage?.(env, origin)");
        expect(shard).toContain("const storage = makeStorage(requestOrigin);");
        // `ctx.origin` is the same gated value, so a handler signing its own URLs
        // gets exactly what `ctx.storage` would, and a query gets nothing.
        expect(shard).toContain("origin: requestOrigin,");
    });

    // `buckets` is a plain object literal, so `buckets[name] ?? fallbackStorage`
    // resolved `?bucket=constructor` / `__proto__` / `toString` to an inherited
    // Object.prototype member — `??` never engaged and the admin storage routes
    // threw `s.delete is not a function` (500) instead of falling back.
    it("resolves the bucket by own property so prototype keys hit the fallback", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).toContain("Object.hasOwn(bindings, wanted)");
        expect(output).not.toContain('buckets[name !== undefined && name !== "" ? name : "default"]');
    });
});

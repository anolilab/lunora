import { describe, expect, it } from "vitest";

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
    hasStorage: true,
    hasVectors: false,
    hasWorkflow: false,
    hasX402: false,
    tableNames: [],
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
        expect(output).toContain('this.makeStorage(env, declaration, defaultBucket, "default")');
        expect(output).toContain("map[name] = this.makeStorage(env, declaration, bucket, name);");
        expect(output).toContain("buckets[name] = this.makeStorage(env, declaration, bucket, name);");
    });

    // `buckets` is a plain object literal, so `buckets[name] ?? fallbackStorage`
    // resolved `?bucket=constructor` / `__proto__` / `toString` to an inherited
    // Object.prototype member — `??` never engaged and the admin storage routes
    // threw `s.delete is not a function` (500) instead of falling back.
    it("resolves the bucket by own property so prototype keys hit the fallback", () => {
        expect.assertions(2);

        const output = emitApp(baseOptions);

        expect(output).toContain("Object.hasOwn(buckets, wanted)");
        expect(output).not.toContain('buckets[name !== undefined && name !== "" ? name : "default"]');
    });
});

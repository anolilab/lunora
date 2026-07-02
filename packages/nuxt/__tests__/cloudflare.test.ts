import { describe, expect, it } from "vitest";

import { resolveCloudflare } from "../src/runtime/cloudflare";

describe("resolveCloudflare", () => {
    it("reads the legacy event.context.cloudflare shape (nitro-cloudflare-dev)", () => {
        expect.assertions(1);

        const env = { SHARD: {} };
        const context = { waitUntil: () => {} };

        expect(resolveCloudflare({ context: { cloudflare: { context, env } } })).toEqual({ ctx: context, env });
    });

    it("reads the newer event.req.runtime.cloudflare shape (Nitro 2.10+)", () => {
        expect.assertions(1);

        const env = { SHARD: {} };
        const ctx = { waitUntil: () => {} };

        expect(resolveCloudflare({ req: { runtime: { cloudflare: { ctx, env } } } })).toEqual({ ctx, env });
    });

    it("prefers the context shape and falls back across the ctx/context alias", () => {
        expect.assertions(1);

        const env = { SHARD: {} };
        const ctx = { waitUntil: () => {} };

        // legacy bag may carry the ExecutionContext under `ctx` instead of `context`
        expect(resolveCloudflare({ context: { cloudflare: { ctx, env } } })).toEqual({ ctx, env });
    });

    it("returns an empty result when no Cloudflare runtime is attached", () => {
        expect.assertions(2);

        expect(resolveCloudflare({})).toEqual({});
        expect(resolveCloudflare({ context: { cloudflare: {} } })).toEqual({});
    });
});

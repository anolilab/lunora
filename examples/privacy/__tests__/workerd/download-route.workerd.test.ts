/**
 * The download route through the Worker. `/privacy/files` is mounted on `buildWorker`, checks the link
 * before it reads the shard, and serves the archive the shard returns. The shard is a spy, so the test
 * sees the internal `requests:exportFile` call the route makes, and a forged link makes no call at all.
 *
 * This runs under workerd, not node, because `buildWorker` resolves the caller's identity on every request.
 * That runs better-auth's migration over the D1 binding, which the node suite's stand-in cannot serve.
 */
import { env } from "cloudflare:test";
import type { ExecutionContextLike, ShardNamespaceLike } from "lunorash/runtime";
import { describe, expect, it } from "vitest";

import { signFileLink } from "../../lunora/privacy-files";
import { buildWorker } from "../../src/server/worker";

const KEY = "request-1/export.zip";
const SIGNATURE = /sig=[\da-f]+/u;
const ZIP_BASE64 = Buffer.from(Uint8Array.of(0x50, 0x4b, 0x03, 0x04)).toString("base64");

const fakeContext: ExecutionContextLike = {
    passThroughOnException: () => undefined,
    waitUntil: () => undefined,
};

/** The Worker's bindings for one test: the shard spy, and the real D1 and secret this suite binds. */
const workerEnv = (shard: { namespace: ShardNamespaceLike }) => {
    return { AUTH_SECRET: env.AUTH_SECRET, DB: env.DB, SHARD: shard.namespace };
};

interface ShardCall {
    args: unknown;
    functionPath: string;
}

/** A shard that answers the archive read with the stored part, and records every call the worker makes. */
const shardSpy = (): { calls: ShardCall[]; namespace: ShardNamespaceLike } => {
    const calls: ShardCall[] = [];

    return {
        calls,
        namespace: {
            get: () => {
                return {
                    fetch: async (request: Request) => {
                        const call: ShardCall = await request.clone().json();

                        calls.push(call);

                        const value = call.functionPath === "requests:exportFile" ? { body: ZIP_BASE64, encoding: "base64", name: "export.zip" } : null;

                        // The runtime reads the shard's reply from `result`.
                        return Response.json({ result: value });
                    },
                };
            },
            idFromName: (name: string) => name,
        },
    };
};

describe("the download route on the Worker", () => {
    it("serves the archive for a signed link, reading it from the shard as an internal call", async () => {
        expect.assertions(3);

        const shard = shardSpy();
        const link = await signFileLink(KEY, 600, Date.now());
        const response = await buildWorker(workerEnv(shard)).fetch(new Request(`http://localhost${link}`), workerEnv(shard), fakeContext);

        expect(response.status).toBe(200);
        expect(response.headers.get("content-type")).toBe("application/zip");
        expect(shard.calls).toContainEqual({ args: { key: KEY }, functionPath: "requests:exportFile" });
    });

    it("refuses a forged link before the shard is read", async () => {
        expect.assertions(2);

        const shard = shardSpy();
        const link = await signFileLink(KEY, 600, Date.now());
        const forged = link.replace(SIGNATURE, `sig=${"00".repeat(32)}`);
        const response = await buildWorker(workerEnv(shard)).fetch(new Request(`http://localhost${forged}`), workerEnv(shard), fakeContext);

        expect(response.status).toBe(404);
        expect(shard.calls.filter((call) => call.functionPath === "requests:exportFile")).toStrictEqual([]);
    });
});

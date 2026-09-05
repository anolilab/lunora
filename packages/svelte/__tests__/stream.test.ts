import type { FunctionReference } from "@lunora/client";
import { get } from "svelte/store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StreamHandle } from "../src/stream";
import { stream } from "../src/stream";
import { createFakeClient } from "./fake-client";

const makeStreamRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

const TICK_REF = "metrics:tick";

// Every subscribing primitive in this package gates on a browser `window` (the
// SSR guard — svelte's server runtime subscribes to `{$store}` during
// `render()`, so a `readable`'s start callback runs on the server too). The
// vitest env is `node`, so define one for the client-path tests. Mirrors the
// same stub in `flag.test.ts` / `presence.test.ts`.
/* eslint-disable vitest/require-top-level-describe -- the `window` stub is shared by every describe in this file, so it belongs at file scope */
beforeAll(() => {
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
});

afterAll(() => {
    Reflect.deleteProperty(globalThis, "window");
});
/* eslint-enable vitest/require-top-level-describe */

describe(stream, () => {
    it("opens a stream on the first chunks subscriber and appends chunks as they arrive", async () => {
        const fake = createFakeClient();
        const handle: StreamHandle<unknown> = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        // The `chunks` store is lazy — the stream opens on its first subscriber.
        const stop = handle.chunks.subscribe(() => {});

        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([TICK_REF]);
        expect(get(handle.status)).toBe("streaming");

        fake.pushStream(TICK_REF, { tick: 1 });
        fake.pushStream(TICK_REF, { tick: 2 });
        await fake.flush();

        expect(get(handle.chunks)).toStrictEqual([{ tick: 1 }, { tick: 2 }]);

        fake.streamCalls[0]?.handle.complete();
        await fake.flush();

        expect(get(handle.status)).toBe("complete");

        stop();
    });

    it("forwards `durable` to the client so a reconnect resumes the run", () => {
        const fake = createFakeClient();
        const handle: StreamHandle<unknown> = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 }, { durable: true });
        const stop = handle.chunks.subscribe(() => {});

        // `{ durable: true }` is what makes a dropped socket resume the same run
        // instead of failing with `STREAM_DISCONNECTED`. The client reads it off the
        // stream options, so a primitive that does not forward it silently gives the
        // caller a non-durable stream — which only shows up on a reconnect.
        expect(fake.streamCalls[0]?.options.durable).toBe(true);

        stop();
    });

    it("'skip' keeps the stores connected without opening a stream", () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), "skip");

        const stop = handle.chunks.subscribe(() => {});

        expect(fake.streamCalls).toHaveLength(0);
        expect(get(handle.status)).toBe("idle");
        expect(get(handle.chunks)).toStrictEqual([]);

        stop();
    });

    it("cancels the in-flight iterator on teardown", () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        const stop = handle.chunks.subscribe(() => {});

        expect(fake.streamCalls).toHaveLength(1);

        handle.teardown();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();

        stop();
    });

    it("cancels the in-flight iterator when the last chunks subscriber detaches", () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        const stop = handle.chunks.subscribe(() => {});

        expect(fake.streamCalls).toHaveLength(1);

        stop();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();
    });

    it("surfaces a server error and transitions status to 'error'", async () => {
        const fake = createFakeClient();
        const handle = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

        const stop = handle.chunks.subscribe(() => {});

        fake.streamCalls[0]?.handle.fail(new Error("forbidden"));
        await fake.flush();

        expect(get(handle.status)).toBe("error");
        expect(get(handle.error)?.message).toBe("forbidden");

        stop();
    });
});

// Regression: `readable`'s start callback is NOT browser-only. Svelte's server
// runtime resolves `{$store}` by calling `subscribe_to_store`, so every store
// read in a server-rendered template runs its start callback — opening a live
// socket per rendered request against a client whose URL does not resolve
// server-side, and throwing straight out of the render when that URL is the
// relative/empty one the SvelteKit template builds.
describe("stream during SSR", () => {
    it("opens no stream without a browser window", () => {
        const original = Reflect.getOwnPropertyDescriptor(globalThis, "window");

        Reflect.deleteProperty(globalThis, "window");

        try {
            const fake = createFakeClient();
            const handle: StreamHandle<unknown> = stream(fake.client, makeStreamRef(TICK_REF), { since: 0 });

            const stop = handle.chunks.subscribe(() => {});

            expect(fake.streamCalls).toHaveLength(0);
            expect(get(handle.status)).toBe("idle");
            expect(get(handle.chunks)).toStrictEqual([]);

            stop();
        } finally {
            if (original) {
                Object.defineProperty(globalThis, "window", original);
            }
        }
    });
});

import type { FunctionReference } from "@lunora/client";
import { get } from "svelte/store";
import { describe, expect, it } from "vitest";

import type { StreamHandle } from "../src/stream";
import { stream } from "../src/stream";
import { createFakeClient } from "./fake-client";

const makeStreamRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

const TICK_REF = "metrics:tick";

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

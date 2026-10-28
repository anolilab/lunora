import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, isReactive, nextTick, ref } from "vue";

import type { UseStreamResult } from "../src/use-stream";
import { useStream } from "../src/use-stream";
import { createFakeClient } from "./fake-client";

const makeStreamRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

const TICK_REF = "metrics:tick";

describe(useStream, () => {
    // `useStream` gates `client.stream(...)` on a browser `window` (SSR guard);
    // the vitest env is `node` (no `window`), so define one for these client-path
    // tests. The dedicated SSR test below removes it to exercise the guard,
    // mirroring `use-subscription.test.ts`.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("opens a stream on setup and appends chunks as they arrive", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() => fake.provide((): UseStreamResult<unknown> => useStream(makeStreamRef(TICK_REF), { since: 0 })))!;

        // The stream opens immediately and reports `streaming` while un-drained.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([TICK_REF]);
        expect(result.status.value).toBe("streaming");

        fake.pushStream(TICK_REF, { since: 0 }, { tick: 1 });
        fake.pushStream(TICK_REF, { since: 0 }, { tick: 2 });
        await fake.flush();

        expect(result.chunks.value).toStrictEqual([{ tick: 1 }, { tick: 2 }]);

        fake.streamCalls[0]?.handle.complete();
        await fake.flush();

        expect(result.status.value).toBe("complete");

        scope.stop();
    });

    it("holds chunks as-is, without reactive proxies", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() => fake.provide((): UseStreamResult<unknown> => useStream(makeStreamRef(TICK_REF), { since: 0 })))!;
        const chunk = { delta: { text: "hi" } };

        fake.pushStream(TICK_REF, { since: 0 }, chunk);
        await fake.flush();

        // Chunks are appended by replacing the array; deep proxies would make each
        // nested read of a long stream pay a proxy trap for nothing.
        expect(result.chunks.value[0]).toBe(chunk);
        expect(isReactive(result.chunks.value)).toBe(false);

        scope.stop();
    });

    it("forwards `durable` to the client so a reconnect resumes the run", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();

        scope.run(() => fake.provide(() => useStream(makeStreamRef(TICK_REF), { since: 0 }, { durable: true })));

        // `{ durable: true }` is what makes a dropped socket resume the same run
        // instead of failing with `STREAM_DISCONNECTED`. The client reads it off the
        // stream options, so a primitive that does not forward it silently gives the
        // caller a non-durable stream — which only shows up on a reconnect.
        expect(fake.streamCalls[0]?.options.durable).toBe(true);

        scope.stop();
    });

    it('"skip" keeps the composable mounted without opening a stream', () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() => fake.provide((): UseStreamResult<unknown> => useStream(makeStreamRef(TICK_REF), "skip")))!;

        expect(fake.streamCalls).toHaveLength(0);
        expect(result.status.value).toBe("idle");
        expect(result.chunks.value).toStrictEqual([]);

        scope.stop();
    });

    it("keeps the stream open when a reactive args source re-emits equal content", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        // `Math.min(limit, 10)` clamps 15 and 20 to the same 10: the getter re-runs
        // and builds a fresh object, but the args it produces are unchanged.
        const limit = ref(15);
        const scope = effectScope();
        const result = scope.run(() =>
            fake.provide((): UseStreamResult<unknown> =>
                useStream(makeStreamRef(TICK_REF), () => {
                    return { limit: Math.min(limit.value, 10) };
                }),
            ),
        )!;

        fake.pushStream(TICK_REF, { limit: 10 }, { tick: 1 });
        await fake.flush();

        limit.value = 20;
        await nextTick();

        expect(fake.streamCalls).toHaveLength(1);
        expect(fake.streamCalls[0]?.onCancel).not.toHaveBeenCalled();
        expect(result.chunks.value).toStrictEqual([{ tick: 1 }]);

        scope.stop();
    });

    it("restarts the stream when the reactive args content changes", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const since = ref(0);
        const scope = effectScope();

        scope.run(() =>
            fake.provide(() =>
                useStream(makeStreamRef(TICK_REF), () => {
                    return { since: since.value };
                }),
            ),
        );

        since.value = 5;
        await nextTick();

        expect(fake.streamCalls).toHaveLength(2);
        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();
        expect(fake.streamCalls[1]?.args).toStrictEqual({ since: 5 });

        scope.stop();
    });

    it("cancels the in-flight iterator when the scope is disposed", () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        scope.run(() => fake.provide(() => useStream(makeStreamRef(TICK_REF), { since: 0 })));

        expect(fake.streamCalls).toHaveLength(1);

        scope.stop();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();
    });

    it("does not open a stream during SSR (no window)", () => {
        expect.hasAssertions();

        const fake = createFakeClient();

        // Simulate the server render: no browser `window`. An `immediate: true`
        // watcher fires during `renderToString` with no unmount to cancel it, so
        // an un-gated stream is held for the life of the server process.
        Reflect.deleteProperty(globalThis, "window");

        const scope = effectScope();
        const result = scope.run(() => fake.provide((): UseStreamResult<unknown> => useStream(makeStreamRef(TICK_REF), { since: 0 })))!;

        expect(fake.streamCalls).toHaveLength(0);
        expect(result.status.value).toBe("idle");
        expect(result.chunks.value).toStrictEqual([]);

        scope.stop();
    });

    it("surfaces a server error and transitions status to 'error'", async () => {
        expect.hasAssertions();

        const fake = createFakeClient();
        const scope = effectScope();
        const result = scope.run(() => fake.provide((): UseStreamResult<unknown> => useStream(makeStreamRef(TICK_REF), { since: 0 })))!;

        fake.streamCalls[0]?.handle.fail(new Error("forbidden"));
        await fake.flush();

        expect(result.status.value).toBe("error");
        expect(result.error.value?.message).toBe("forbidden");

        scope.stop();
    });
});

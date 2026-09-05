import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope } from "vue";

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

import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { stream } from "../src/stream";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const makeStreamRef = (reference: string): FunctionReference<"stream"> => {
    return { __lunoraRef: reference };
};

const TICK_REF = "metrics:tick";

describe(stream, () => {
    it("opens a stream on setup and appends chunks as they arrive", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result = stream(makeStreamRef(TICK_REF), { since: 0 }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        // The stream opens immediately and reports `streaming` while un-drained.
        expect(fake.streamCalls.map((call) => call.functionPath)).toStrictEqual([TICK_REF]);
        expect(result.status()).toBe("streaming");

        fake.pushStream(TICK_REF, { since: 0 }, { tick: 1 });
        fake.pushStream(TICK_REF, { since: 0 }, { tick: 2 });
        await fake.flush();

        expect(result.chunks()).toStrictEqual([{ tick: 1 }, { tick: 2 }]);

        fake.streamCalls[0]?.handle.complete();
        await fake.flush();

        expect(result.status()).toBe("complete");

        destroy.destroy();
    });

    it('"skip" keeps the primitive mounted without opening a stream', () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result = stream(makeStreamRef(TICK_REF), "skip", { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.streamCalls).toHaveLength(0);
        expect(result.status()).toBe("idle");
        expect(result.chunks()).toStrictEqual([]);

        destroy.destroy();
    });

    it("cancels the in-flight iterator when the DestroyRef fires", () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        stream(makeStreamRef(TICK_REF), { since: 0 }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        expect(fake.streamCalls).toHaveLength(1);

        destroy.destroy();

        expect(fake.streamCalls[0]?.onCancel).toHaveBeenCalledWith();
    });

    it("surfaces a server error and transitions status to 'error'", async () => {
        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        const result = stream(makeStreamRef(TICK_REF), { since: 0 }, { client: fake.asClient, destroyRef: destroy.asDestroyRef });

        fake.streamCalls[0]?.handle.fail(new Error("forbidden"));
        await fake.flush();

        expect(result.status()).toBe("error");
        expect(result.error()?.message).toBe("forbidden");

        destroy.destroy();
    });
});

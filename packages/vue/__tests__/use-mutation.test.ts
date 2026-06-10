import type { FunctionReference, OptimisticLocalStore } from "@cirrus/client";
import { describe, expect, it } from "vitest";
import { effectScope } from "vue";

import { useMutation } from "../src/use-mutation";
import { createFakeClient } from "./fake-client";

const sendMessage: FunctionReference = { __cirrusRef: "messages:send" };

describe(useMutation, () => {
    it("resolves with the server value, exposing reactive data/pending refs", async () => {
        const fake = createFakeClient();
        fake.mutationSpy.mockResolvedValue({ id: "m1", text: "hi" });

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useMutation(sendMessage)))!;

        expect(handle.pending.value).toBe(false);
        expect(handle.data.value).toBeUndefined();

        const result = await handle.mutate({ channelId: "c1", text: "hi" });

        expect(result).toStrictEqual({ id: "m1", text: "hi" });
        expect(handle.data.value).toStrictEqual({ id: "m1", text: "hi" });
        expect(handle.error.value).toBeUndefined();
        expect(handle.pending.value).toBe(false);

        // No per-call options → the runner forwards `undefined`, which
        // `CirrusClient.mutation`'s default param resolves to `{}`.
        expect(fake.mutationSpy).toHaveBeenCalledWith(sendMessage, { channelId: "c1", text: "hi" }, undefined);

        scope.stop();
    });

    it("captures the error and rejects on failure", async () => {
        const fake = createFakeClient();
        fake.mutationSpy.mockRejectedValue(new Error("boom"));

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useMutation(sendMessage)))!;

        await expect(handle.mutate({ channelId: "c1", text: "x" })).rejects.toThrow("boom");
        expect(handle.error.value?.message).toBe("boom");
        expect(handle.pending.value).toBe(false);

        handle.reset();

        expect(handle.error.value).toBeUndefined();

        scope.stop();
    });

    it("forwards a per-call optimisticUpdate straight through to client.mutation", async () => {
        const fake = createFakeClient();
        fake.mutationSpy.mockResolvedValue(undefined);

        const perCall = (_store: OptimisticLocalStore): void => undefined;

        const scope = effectScope();
        const handle = scope.run(() => fake.provide(() => useMutation(sendMessage)))!;

        await handle.mutate({ channelId: "c1", text: "b" }, { optimisticUpdate: perCall });

        expect(fake.mutationSpy).toHaveBeenLastCalledWith(sendMessage, { channelId: "c1", text: "b" }, { optimisticUpdate: perCall });

        scope.stop();
    });
});

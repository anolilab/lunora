import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { effectScope, nextTick, ref } from "vue";

import { useQuery } from "../src/use-query";
import { createFakeClient } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as unknown as FunctionReference;

describe(useQuery, () => {
    // `useQuery` gates its live subscription on a browser `window` (SSR guard);
    // the vitest env is `node`, so define one for these client-path tests.
    beforeEach(() => {
        Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    });

    afterEach(() => {
        Reflect.deleteProperty(globalThis, "window");
    });

    it("does not re-subscribe when a reactive args source re-emits equal content", async () => {
        const fake = createFakeClient();
        // A dependency that feeds the args getter without changing what it
        // produces — `Math.min(limit, 10)` clamps 15 and 20 to the same 10.
        const limit = ref(15);

        const scope = effectScope();
        const data = scope.run(() =>
            fake.provide(() =>
                useQuery(listRef, () => {
                    return { channelId: "c1", limit: Math.min(limit.value, 10) };
                }),
            ),
        )!;

        expect(fake.subscribeCalls).toHaveLength(1);

        fake.push("messages:list", { channelId: "c1", limit: 10 }, ["a"]);

        expect(data.value).toStrictEqual(["a"]);

        limit.value = 20;
        await nextTick();

        // The produced args are byte-identical, so the live subscription must be
        // left alone — no teardown, no re-open, and no blanking of the list.
        expect(fake.unsubscribeSpy).not.toHaveBeenCalled();
        expect(fake.subscribeCalls).toHaveLength(1);
        expect(data.value).toStrictEqual(["a"]);

        scope.stop();
    });

    it("re-subscribes when the reactive args content actually changes", async () => {
        const fake = createFakeClient();
        const channelId = ref("c1");

        const scope = effectScope();
        const data = scope.run(() =>
            fake.provide(() =>
                useQuery(listRef, () => {
                    return { channelId: channelId.value };
                }),
            ),
        )!;

        fake.push("messages:list", { channelId: "c1" }, ["a"]);

        expect(data.value).toStrictEqual(["a"]);

        channelId.value = "c2";
        await nextTick();

        expect(fake.unsubscribeSpy).toHaveBeenCalledTimes(1);
        expect(fake.subscribeCalls).toHaveLength(2);
        expect(fake.subscribeCalls[1]?.args).toStrictEqual({ channelId: "c2" });
        expect(data.value).toBeUndefined();

        scope.stop();
    });
});

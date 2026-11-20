import { Injector, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { FunctionReference } from "@lunora/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { presence } from "../src/presence";
import { createFakeClient, createFakeDestroyRef } from "./fake-client";

const heartbeatRef = { __lunoraRef: "presence:heartbeat" } as FunctionReference<"mutation", { roomId: string; sessionId: string }>;
const listPresentRef = { __lunoraRef: "presence:listPresent" } as FunctionReference<"query", { roomId: string }>;

describe("presence — reactive room id", () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    });

    afterEach(() => {
        TestBed.resetTestingModule();
    });

    it("leaves the old room, joins the new one at once, and drops the old room's data", () => {
        expect.assertions(10);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = TestBed.inject(Injector);
        const room = signal("a");

        const { present } = presence(() => room(), {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            injector,
            // A long interval, so only a room-change heartbeat can reach the new room.
            intervalMs: 60_000,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        TestBed.tick();
        fake.subscriptions[0]?.push(["alice"]);

        expect(present()).toStrictEqual(["alice"]);

        room.set("b");
        TestBed.tick();

        expect(fake.mutationCalls.map((call) => (call.args as { roomId: string }).roomId)).toStrictEqual(["a", "b"]);
        expect(fake.subscriptions.map((subscription) => subscription.args)).toStrictEqual([{ roomId: "a" }, { roomId: "b" }]);
        expect(fake.subscriptions.map((subscription) => subscription.unsubscribed)).toStrictEqual([true, false]);
        expect(fake.connectionContexts.map((holder) => holder.context)).toStrictEqual([
            { roomId: "a", sessionId: "sess-1" },
            { roomId: "b", sessionId: "sess-1" },
        ]);
        expect(fake.connectionContexts.map((holder) => holder.released)).toStrictEqual([true, false]);
        expect(present()).toBeUndefined();

        // A late push for the room that was left must not appear under the new one.
        fake.subscriptions[0]?.push(["stale"]);

        expect(present()).toBeUndefined();

        fake.subscriptions[1]?.push(["bob"]);

        expect(present()).toStrictEqual(["bob"]);

        destroy.destroy();

        expect(fake.subscriptions[1]?.unsubscribed).toBe(true);
    });
});

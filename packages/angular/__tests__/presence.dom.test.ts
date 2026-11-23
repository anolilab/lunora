import { Injector, PLATFORM_ID, provideZonelessChangeDetection, signal } from "@angular/core";
import { TestBed } from "@angular/core/testing";
import type { FunctionReference, LunoraClient, SubscriptionError } from "@lunora/client";
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

describe("presence — teardown and platform edges", () => {
    beforeEach(() => {
        TestBed.configureTestingModule({ providers: [provideZonelessChangeDetection()] });
    });

    afterEach(() => {
        TestBed.resetTestingModule();
    });

    const refusal: SubscriptionError = { code: "FORBIDDEN", message: "no" };

    it("leaves each room it stops showing, and the last one on destroy, through the leave mutation", async () => {
        expect.assertions(1);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const room = signal("a");
        const leaveRef = { __lunoraRef: "presence:leave" } as FunctionReference<"mutation", { roomId: string; sessionId: string }>;
        const leftB = Promise.withResolvers<undefined>();
        const record = fake.asClient.mutation.bind(fake.asClient);

        // A leave waits for its room's heartbeat to settle, so the last one is awaited, not assumed.
        (fake.asClient as unknown as { mutation: unknown }).mutation = async (...args: Parameters<typeof record>) => {
            const result = await record(...args);

            if ((args[0] as unknown as Record<string, unknown>)["__lunoraRef"] === "presence:leave" && (args[1] as { roomId: string }).roomId === "b") {
                leftB.resolve(undefined);
            }

            return result;
        };

        presence(() => room(), {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            injector: TestBed.inject(Injector),
            intervalMs: 60_000,
            leave: leaveRef,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        TestBed.tick();
        room.set("b");
        TestBed.tick();
        destroy.destroy();
        await leftB.promise;

        expect(fake.mutationCalls.filter((call) => call.functionPath === "presence:leave").map((call) => call.args)).toStrictEqual([
            { roomId: "a", sessionId: "sess-1" },
            { roomId: "b", sessionId: "sess-1" },
        ]);
    });

    it("sends a room's leave only after the heartbeat still in flight for it has settled", async () => {
        expect.assertions(2);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const heartbeatLanded = Promise.withResolvers<undefined>();
        const leaveRef = { __lunoraRef: "presence:leave" } as FunctionReference<"mutation", { roomId: string; sessionId: string }>;
        const client = fake.asClient;
        const record = client.mutation.bind(client);

        const leaveSent = Promise.withResolvers<undefined>();

        (client as unknown as { mutation: unknown }).mutation = async (...args: Parameters<typeof record>) => {
            await record(...args);

            if ((args[0] as unknown as Record<string, unknown>)["__lunoraRef"] === "presence:leave") {
                leaveSent.resolve(undefined);
            }

            return (args[0] as unknown as Record<string, unknown>)["__lunoraRef"] === "presence:heartbeat" ? heartbeatLanded.promise : undefined;
        };

        presence("a", { client, destroyRef: destroy.asDestroyRef, heartbeat: heartbeatRef, leave: leaveRef, listPresent: listPresentRef, sessionId: "sess-1" });
        destroy.destroy();

        expect(fake.mutationCalls.map((call) => call.functionPath)).toStrictEqual(["presence:heartbeat"]);

        heartbeatLanded.resolve(undefined);
        await leaveSent.promise;

        expect(fake.mutationCalls.map((call) => call.functionPath)).toStrictEqual(["presence:heartbeat", "presence:leave"]);
    });

    it("never queues a heartbeat for offline replay", () => {
        expect.assertions(1);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();

        presence("a", { client: fake.asClient, destroyRef: destroy.asDestroyRef, heartbeat: heartbeatRef, listPresent: listPresentRef, sessionId: "sess-1" });

        expect(fake.mutationCalls[0]?.options).toMatchObject({ onlineOnly: true });

        destroy.destroy();
    });

    it("releases a room whose owner is destroyed while its subscription replays a refusal", () => {
        expect.assertions(2);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const client = fake.asClient;
        const original = client.subscribe.bind(client);

        // A replayed refusal reaches onError before subscribe returns.
        (client as unknown as { subscribe: unknown }).subscribe = (...args: Parameters<LunoraClient["subscribe"]>) => {
            const unsubscribe = original(...args);

            fake.subscriptions.at(-1)?.emitError(refusal);

            return unsubscribe;
        };

        presence("a", {
            client,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            listPresent: listPresentRef,
            onError: () => {
                destroy.destroy();
            },
            sessionId: "sess-1",
        });

        expect(fake.connectionContexts.map((holder) => holder.released)).toStrictEqual([true]);
        expect(fake.subscriptions.map((subscription) => subscription.unsubscribed)).toStrictEqual([true]);
    });

    it("rolls a room's setup back when subscribing to it throws", () => {
        expect.assertions(2);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const client = fake.asClient;

        (client as unknown as { subscribe: unknown }).subscribe = () => {
            throw new Error("client closed");
        };

        expect(() =>
            presence("a", { client, destroyRef: destroy.asDestroyRef, heartbeat: heartbeatRef, listPresent: listPresentRef, sessionId: "sess-1" }),
        ).toThrow("client closed");
        expect(fake.connectionContexts.map((holder) => holder.released)).toStrictEqual([true]);
    });

    it("opens nothing on the server platform when a server injector is passed with a destroyRef", () => {
        expect.assertions(2);

        const fake = createFakeClient();
        const destroy = createFakeDestroyRef();
        const injector = Injector.create({ providers: [{ provide: PLATFORM_ID, useValue: "server" }] });

        presence(() => "a", {
            client: fake.asClient,
            destroyRef: destroy.asDestroyRef,
            heartbeat: heartbeatRef,
            injector,
            listPresent: listPresentRef,
            sessionId: "sess-1",
        });

        expect(fake.mutationCalls).toHaveLength(0);
        expect(fake.subscriptions).toHaveLength(0);
    });
});

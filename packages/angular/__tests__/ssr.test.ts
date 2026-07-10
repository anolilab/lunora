import type { Injector } from "@angular/core";
import { Injector as AngularInjector, PLATFORM_ID, runInInjectionContext } from "@angular/core";
import type { FunctionReference, Preloaded } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { LUNORA_CLIENT } from "../src/client";
import { hydratePreloaded } from "../src/hydrate-preloaded";
import { liveQuery } from "../src/live-query";
import { paginatedQuery } from "../src/paginated-query";
import { presence } from "../src/presence";
import { subscription } from "../src/subscription";
import { createFakeClient } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as FunctionReference;
const heartbeatRef = { __lunoraRef: "presence:heartbeat" } as FunctionReference<"mutation", { roomId: string; sessionId: string }>;
const listPresentRef = { __lunoraRef: "presence:listPresent" } as FunctionReference<"query", { roomId: string }>;

/**
 * SSR safety: on the Angular **server** platform every socket-opening primitive
 * must leave its signal at the seed value and open no subscription. Node 22+
 * ships a global `WebSocket`, so an un-gated `client.subscribe(...)` in a field
 * initializer would fire a real connection during the server render (and throw
 * on the default relative `/_lunora/ws` URL). These exercise the real
 * `PLATFORM_ID` DI path via `runInInjectionContext`.
 */
describe("ssr platform gating", () => {
    const makeInjector = (fake: ReturnType<typeof createFakeClient>, platform: string): Injector =>
        AngularInjector.create({
            providers: [
                { provide: LUNORA_CLIENT, useValue: fake.asClient },
                { provide: PLATFORM_ID, useValue: platform },
            ],
        });

    it("liveQuery opens no subscription on the server platform", () => {
        const fake = createFakeClient();

        const data = runInInjectionContext(makeInjector(fake, "server"), () => liveQuery(listRef, { channelId: "general" }));

        expect(fake.subscriptions).toHaveLength(0);
        expect(data()).toBeUndefined();
    });

    it("liveQuery DOES subscribe on the browser platform", () => {
        const fake = createFakeClient();

        runInInjectionContext(makeInjector(fake, "browser"), () => liveQuery(listRef, { channelId: "general" }));

        expect(fake.subscriptions).toHaveLength(1);
    });

    it("subscription opens no subscription on the server platform", () => {
        const fake = createFakeClient();

        const { data, error } = runInInjectionContext(makeInjector(fake, "server"), () => subscription(listRef, { roomId: "general" }));

        expect(fake.subscriptions).toHaveLength(0);
        expect(data()).toBeUndefined();
        expect(error()).toBeUndefined();
    });

    it("paginatedQuery opens no subscription on the server platform", () => {
        const fake = createFakeClient();

        const { status } = runInInjectionContext(makeInjector(fake, "server"), () => paginatedQuery(listRef, {}, { initialNumItems: 5 }));

        expect(fake.subscriptions).toHaveLength(0);
        expect(status()).toBe("LoadingFirstPage");
    });

    it("presence starts no network side effects on the server platform", () => {
        const fake = createFakeClient();

        const { present, sessionId } = runInInjectionContext(makeInjector(fake, "server"), () =>
            presence("room:1", { heartbeat: heartbeatRef, listPresent: listPresentRef, sessionId: "sess-1" }), );

        expect(fake.subscriptions).toHaveLength(0);
        expect(fake.mutationCalls).toHaveLength(0);
        expect(fake.connectionContexts).toHaveLength(0);
        expect(present()).toBeUndefined();
        expect(sessionId).toBe("sess-1");
    });

    it("hydratePreloaded keeps its synchronous seed but opens no subscription on the server platform", () => {
        const fake = createFakeClient();
        const preloaded = { args: { channelId: "general" }, functionPath: "messages:list", shardKey: undefined, value: { messages: ["seed"] } } as unknown as Preloaded<{
            messages: string[];
        }>;

        const { data } = runInInjectionContext(makeInjector(fake, "server"), () => hydratePreloaded(preloaded));

        expect(fake.subscriptions).toHaveLength(0);
        // The server value still renders — no loading flash, no hydration mismatch.
        expect(data()).toStrictEqual({ messages: ["seed"] });
    });
});

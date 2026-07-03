import type { EnvironmentProviders, Injector } from "@angular/core";
import { Injector as AngularInjector, runInInjectionContext } from "@angular/core";
import type { FunctionReference } from "@lunora/client";
import { describe, expect, it } from "vitest";

import { injectLunoraClient, LUNORA_CLIENT, provideLunora } from "../src/client";
import { liveQuery } from "../src/live-query";
import { mutate } from "../src/mutate";
import { createFakeClient } from "./fake-client";

const listRef = { __lunoraRef: "messages:list" } as FunctionReference;
const sendRef = { __lunoraRef: "messages:send" } as FunctionReference;

/**
 * These exercise the real `inject()` path: `liveQuery` / `mutate` /
 * `injectLunoraClient` with no explicit `client` or `destroyRef`, resolved from
 * the injector. `runInInjectionContext` + `Injector.create` provide the injection
 * context a component field initializer would, without a full component harness —
 * `inject(DestroyRef)` resolves the injector's own `DestroyRef`, whose lifetime is
 * the injector's, so destroying the injector tears the subscription down.
 */
describe("injection context", () => {
    const makeInjector = (fakeClient: ReturnType<typeof createFakeClient>): Injector & { destroy: () => void } =>
        AngularInjector.create({
            providers: [{ provide: LUNORA_CLIENT, useValue: fakeClient.asClient }],
        }) as Injector & { destroy: () => void };

    it("injectLunoraClient resolves the provided client", () => {
        const fake = createFakeClient();

        runInInjectionContext(makeInjector(fake), () => {
            expect(injectLunoraClient()).toBe(fake.asClient);
        });
    });

    it("liveQuery resolves client + DestroyRef from the injector and tears down when the injector is destroyed", () => {
        const fake = createFakeClient();
        const injector = makeInjector(fake);

        const data = runInInjectionContext(injector, () => liveQuery(listRef, { channelId: "general" }));

        expect(fake.subscriptions).toHaveLength(1);
        expect(data()).toBeUndefined();

        fake.subscriptions[0]?.push({ messages: ["a"] });

        expect(data()).toStrictEqual({ messages: ["a"] });

        expect(fake.subscriptions[0]?.unsubscribed).toBe(false);

        injector.destroy();

        expect(fake.subscriptions[0]?.unsubscribed).toBe(true);
    });

    it("mutate resolves the client from the injector", async () => {
        const fake = createFakeClient();
        fake.setMutationResult({ id: "msg_1" });

        const promise = runInInjectionContext(makeInjector(fake), () => mutate(sendRef, { text: "hi" }));

        await expect(promise).resolves.toStrictEqual({ id: "msg_1" });
        expect(fake.mutationCalls[0]?.functionPath).toBe("messages:send");
    });

    it("provideLunora returns EnvironmentProviders", () => {
        const providers: EnvironmentProviders = provideLunora({ url: "https://api.example.com" });

        expect(providers).toBeDefined();
    });
});

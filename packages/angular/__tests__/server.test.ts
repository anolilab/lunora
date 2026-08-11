import type { Injector } from "@angular/core";
import { Injector as AngularInjector, PLATFORM_ID, runInInjectionContext } from "@angular/core";
import type { FunctionReference } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { LUNORA_CLIENT } from "../src/client";
import { hydratePreloaded } from "../src/hydrate-preloaded";
import { createServerClient, deserializePreloaded, preloadedQueryResult, preloadQuery, serializePreloaded } from "../src/server";
import { createFakeClient } from "./fake-client";

const postsListRef = { __lunoraRef: "posts:list" } as FunctionReference<"query", Record<string, never>, { title: string }>;

/** Minimal `fetch` double that returns one RPC `{ result }` envelope and records the request. */
const mockFetch = (result: unknown): ReturnType<typeof vi.fn> =>
    vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(
        async () =>
            ({
                headers: { get: () => null },
                json: async () => {
                    return { result };
                },
                ok: true,
                status: 200,
            }) as unknown as Response,
    );

describe("@lunora/angular/server round trip", () => {
    it("createServerClient -> preloadQuery -> serialize -> deserialize -> hydratePreloaded seeds synchronously", async () => {
        expect.assertions(3);

        const fetchImpl = mockFetch({ title: "hello" });
        const client = createServerClient({ fetch: fetchImpl as unknown as typeof fetch, url: "https://app.example.dev" });

        const preloaded = await preloadQuery(client, postsListRef, {});

        expect(preloadedQueryResult(preloaded)).toStrictEqual({ title: "hello" });

        // Round-trip through the script-safe serializer, exactly like a
        // framework's SSR dehydration would.
        const wireToken = deserializePreloaded(serializePreloaded(preloaded));

        const fake = createFakeClient();
        const injector: Injector = AngularInjector.create({
            providers: [
                { provide: LUNORA_CLIENT, useValue: fake.asClient },
                { provide: PLATFORM_ID, useValue: "browser" },
            ],
        });

        const { data } = runInInjectionContext(injector, () => hydratePreloaded(wireToken));

        // Seeded synchronously from the deserialized token — no async wait needed.
        expect(data()).toStrictEqual({ title: "hello" });
        expect(fake.subscriptions).toHaveLength(1);
    });
});

describe("@lunora/angular/server opens no WebSocket and touches no browser globals", () => {
    it("has no window/document in its test environment and imports cleanly", async () => {
        expect.assertions(3);

        expect(globalThis.window).toBeTypeOf("undefined");
        expect(globalThis.document).toBeTypeOf("undefined");

        await expect(import("../src/server")).resolves.toBeDefined();
    });
});

describe("@lunora/angular/server export parity", () => {
    it("re-exports exactly the value surface @lunora/client/ssr publishes (the shared source of truth every adapter's /server mirrors)", async () => {
        expect.assertions(1);

        const angularServer = await import("../src/server");
        const clientSsr = await import("@lunora/client/ssr");

        // Type-only exports are erased at runtime, so comparing `Object.keys`
        // at runtime checks value-export parity. This asserts against
        // `@lunora/client/ssr` directly rather than another adapter's copy,
        // since a hand-mirrored sibling could itself be stale.
        const sortAlpha = (names: string[]): string[] => names.toSorted((a, b) => a.localeCompare(b));

        expect(sortAlpha(Object.keys(angularServer))).toStrictEqual(sortAlpha(Object.keys(clientSsr)));
    });
});

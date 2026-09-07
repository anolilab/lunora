import { LunoraClient } from "@lunora/client";
import { describe, expect, it, vi } from "vitest";

import { createLunoraClient, withAuthHeaders, withAuthWebSocket } from "../src/create-lunora-client";

const makeFetchSpy = () =>
    vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>((_input, _init) => Promise.resolve(new Response(null, { status: 204 })));

describe("withAuthHeaders", () => {
    it("merges the auth headers under the caller's own headers", async () => {
        expect.assertions(3);

        const spy = makeFetchSpy();
        const wrapped = withAuthHeaders(spy, () => {
            return { Cookie: "session=abc", "X-App": "demo" };
        });

        await wrapped("https://api.example.com/rpc", { headers: { "Content-Type": "application/json" } });

        const headers = new Headers(spy.mock.calls[0]![1]!.headers);

        expect(headers.get("cookie")).toBe("session=abc");
        expect(headers.get("x-app")).toBe("demo");
        // The caller's own headers survive alongside the injected auth headers.
        expect(headers.get("content-type")).toBe("application/json");
    });

    it("lets the caller's headers win on a key clash (an explicit bearer beats the factory)", async () => {
        expect.assertions(1);

        const spy = makeFetchSpy();
        const wrapped = withAuthHeaders(spy, () => {
            return { authorization: "Bearer from-factory" }; // secret-scanner:allow -- test fixture, not a real credential
        });

        await wrapped("https://api.example.com/rpc", { headers: { authorization: "Bearer from-caller" } }); // secret-scanner:allow -- test fixture, not a real credential

        expect(new Headers(spy.mock.calls[0]![1]!.headers).get("authorization")).toBe("Bearer from-caller");
    });

    it("passes the request straight through when the factory returns undefined (signed out)", async () => {
        expect.assertions(1);

        const spy = makeFetchSpy();
        const init: RequestInit = { headers: { "Content-Type": "application/json" } };
        const wrapped = withAuthHeaders(spy, () => undefined);

        await wrapped("https://api.example.com/rpc", init);

        // Untouched init object — no wrapping allocation when there's nothing to add.
        expect(spy.mock.calls[0]![1]).toBe(init);
    });

    it("re-reads the factory on every call so a refreshed credential takes effect", async () => {
        expect.assertions(2);

        const spy = makeFetchSpy();
        let cookie = "session=first";
        const wrapped = withAuthHeaders(spy, () => {
            return { Cookie: cookie };
        });

        await wrapped("https://api.example.com/rpc");
        cookie = "session=second";
        await wrapped("https://api.example.com/rpc");

        expect(new Headers(spy.mock.calls[0]![1]!.headers).get("cookie")).toBe("session=first");
        expect(new Headers(spy.mock.calls[1]![1]!.headers).get("cookie")).toBe("session=second");
    });
});

describe("withAuthWebSocket", () => {
    // A fake React Native WebSocket that records its constructor arguments — the
    // real one accepts a third `{ headers }` options argument the browser lacks.
    const makeFakeWebSocket = () => {
        const calls: { options?: unknown; protocols?: string | string[]; url: string | URL }[] = [];

        // eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a recording stub: the constructor's side effect is the whole point
        class FakeWebSocket {
            public constructor(url: string | URL, protocols?: string | string[], options?: unknown) {
                calls.push({ options, protocols, url });
            }
        }

        return { calls, FakeWebSocket: FakeWebSocket as unknown as typeof WebSocket };
    };

    it("injects the current headers onto the upgrade request", () => {
        expect.assertions(3);

        const { calls, FakeWebSocket } = makeFakeWebSocket();
        const Wrapped = withAuthWebSocket(FakeWebSocket, () => {
            return { Cookie: "session=abc" };
        });

        const socket = new Wrapped("wss://api.example.com/_lunora/ws");

        expect(socket).toBeInstanceOf(Wrapped);
        expect(calls[0]!.url).toBe("wss://api.example.com/_lunora/ws");
        expect(calls[0]!.options).toStrictEqual({ headers: { Cookie: "session=abc" } });
    });

    it("passes no options object when signed out", () => {
        expect.assertions(2);

        const { calls, FakeWebSocket } = makeFakeWebSocket();
        const Wrapped = withAuthWebSocket(FakeWebSocket, () => undefined);

        const socket = new Wrapped("wss://api.example.com/_lunora/ws");

        expect(socket).toBeInstanceOf(Wrapped);
        expect(calls[0]!.options).toBeUndefined();
    });

    it("re-reads the factory per socket so a reconnect picks up a new token", () => {
        expect.assertions(4);

        const { calls, FakeWebSocket } = makeFakeWebSocket();
        let cookie = "session=first";
        const Wrapped = withAuthWebSocket(FakeWebSocket, () => {
            return { Cookie: cookie };
        });

        const first = new Wrapped("wss://api.example.com/_lunora/ws");

        cookie = "session=second";

        const second = new Wrapped("wss://api.example.com/_lunora/ws");

        expect(first).toBeInstanceOf(Wrapped);
        expect(second).toBeInstanceOf(Wrapped);
        expect(calls[0]!.options).toStrictEqual({ headers: { Cookie: "session=first" } });
        expect(calls[1]!.options).toStrictEqual({ headers: { Cookie: "session=second" } });
    });
});

describe("createLunoraClient", () => {
    it("constructs a LunoraClient with the given url", () => {
        expect.assertions(2);

        const client = createLunoraClient({ url: "https://api.example.com" });

        expect(client).toBeInstanceOf(LunoraClient);
        expect(client.url).toBe("https://api.example.com");
    });

    it("derives an AsyncStorage persistence adapter from `storage`", () => {
        expect.assertions(1);

        const store = new Map<string, string>();
        const storage = {
            getItem: async (key: string) => store.get(key) ?? null,
            removeItem: async (key: string) => {
                store.delete(key);
            },
            setItem: async (key: string, value: string) => {
                store.set(key, value);
            },
        };

        // A smoke assertion: constructing with `storage` wires persistence without
        // throwing. The adapter itself is covered by @lunora/client's own suite.
        expect(() => createLunoraClient({ storage, url: "https://api.example.com" })).not.toThrow();
    });

    it("honours an explicit `persistence: false` over `storage`, and still wires the query cache", async () => {
        expect.assertions(1);

        const reads: string[] = [];
        const storage = {
            getItem: async (key: string) => {
                reads.push(key);

                return null;
            },
            removeItem: async () => {},
            setItem: async () => {},
        };

        // `storage` backs two independent caches and each has its own opt-out, so
        // turning off the mutation queue leaves query results still written to
        // AsyncStorage. Asserted rather than smoke-tested because the option's
        // docs used to read as though `persistence: false` disabled both.
        const client = createLunoraClient({ persistence: false, storage, url: "https://api.example.com" });

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        client.close();

        expect(reads).toContain("lunora:query-cache");
    });

    it("derives an AsyncStorage query cache from `storage`", async () => {
        expect.assertions(1);

        const reads: string[] = [];
        const storage = {
            getItem: async (key: string) => {
                reads.push(key);

                return null;
            },
            removeItem: async () => {},
            setItem: async () => {},
        };

        const client = createLunoraClient({ storage, url: "https://api.example.com" });

        // Cache hydration runs on a construction-time microtask; a wired query
        // cache shows up as a read of its storage key.
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        client.close();

        expect(reads).toContain("lunora:query-cache");
    });

    it("honours an explicit `queryCache: false` over `storage`", async () => {
        expect.assertions(1);

        const reads: string[] = [];
        const storage = {
            getItem: async (key: string) => {
                reads.push(key);

                return null;
            },
            removeItem: async () => {},
            setItem: async () => {},
        };

        const client = createLunoraClient({ queryCache: false, storage, url: "https://api.example.com" });

        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
        client.close();

        expect(reads).not.toContain("lunora:query-cache");
    });
});

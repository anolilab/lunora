import { describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createInMemoryPersistence } from "../src/persistence";
import type { FunctionReference } from "../src/types";

/**
 * A function with a `v.sensitive` argument is emitted as a reference carrying
 * `sensitive: true`, and the client forces it online-only: its arguments never
 * reach the offline queue, the outbox or the persistence adapter. A caller cannot
 * opt out, and passing `onlineOnly: false` is refused. The argument is named
 * `value` here on purpose: the guard keys on the reference, not on any name.
 */

const SECRET = "SECRET-VALUE-42";

type SensitiveRef = FunctionReference<"mutation", { value: string }> & { readonly sensitive: true };

const sensitiveRef = (reference: string): SensitiveRef => {
    return { __lunoraRef: reference, sensitive: true };
};

const plainRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await new Promise((resolve) => {
            setTimeout(resolve, 0);
        });
    }
};

interface MockSocket {
    open: () => void;
    triggerClose: () => void;
}

const createMockWebSocket = (sockets: MockSocket[]): typeof WebSocket => {
    class WS {
        public readyState = 0;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor() {
            sockets.push({
                open: () => {
                    this.readyState = 1;
                    this.emit("open");
                },
                triggerClose: () => {
                    this.readyState = 3;
                    this.emit("close");
                },
            });
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public close(): void {
            this.readyState = 3;
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        // eslint-disable-next-line class-methods-use-this -- a no-op socket: the write under test never reaches it
        public send(): void {}

        private emit(type: string): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener();
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

/** Every request body the server received, so a leaked secret is visible. */
const createServer = (): { bodies: string[]; fetch: typeof fetch } => {
    const bodies: string[] = [];

    const fetchImpl = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url, init) => {
        if (url.includes("get-session")) {
            return Response.json({ error: "nope" }, { status: 401 });
        }

        bodies.push(typeof init?.body === "string" ? init.body : "");

        return Response.json({ result: { ok: true } }, { status: 200 });
    });

    return { bodies, fetch: fetchImpl as unknown as typeof fetch };
};

const newClient = (server: { fetch: typeof fetch }, sockets: MockSocket[], persistence = createInMemoryPersistence()): LunoraClient =>
    new LunoraClient({
        fetch: server.fetch,
        heartbeatIntervalMs: 0,
        persistence,
        url: "http://app.test",
        WebSocket: createMockWebSocket(sockets),
    });

describe("sensitive mutation", () => {
    it("is refused at once while disconnected, and its args never reach the queue or the adapter", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const client = newClient(server, sockets, persistence);

        client.subscribe(plainRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        await settle();
        sockets.at(-1)?.triggerClose();
        await settle();

        // No `onlineOnly` on the call: the client forces it, so the write is refused
        // rather than queued the way a normal mutation is.
        await expect(client.mutation(sensitiveRef("agents:supply"), { value: SECRET })).rejects.toMatchObject({ code: "OFFLINE_NOT_QUEUED" });

        await settle();

        expect(server.bodies.join("")).not.toContain(SECRET);
        expect(append).not.toHaveBeenCalled();
        await expect(persistence.load()).resolves.toStrictEqual([]);
        expect(client.pendingCount()).toBe(0);

        client.close();
    });

    it("sends normally while the connection is live, with the secret in the request body", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const persistence = createInMemoryPersistence();
        const append = vi.spyOn(persistence, "append");
        const client = newClient(server, sockets, persistence);

        client.subscribe(plainRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        await settle();

        await expect(client.mutation(sensitiveRef("agents:supply"), { value: SECRET })).resolves.toStrictEqual({ ok: true });

        expect(server.bodies.join("")).toContain(SECRET);
        expect(append).not.toHaveBeenCalled();

        client.close();
    });

    it("refuses an explicit onlineOnly: false before any work, as a bad request", async () => {
        expect.hasAssertions();

        const sockets: MockSocket[] = [];
        const server = createServer();
        const client = newClient(server, sockets);

        client.subscribe(plainRef("todos.list"), {}, () => {});
        sockets.at(-1)?.open();
        await settle();

        // The option is typed away for a sensitive reference; this proves the runtime
        // refusal for a caller that bypasses the types.
        const optOut: { onlineOnly: boolean } = { onlineOnly: false };

        await expect(client.mutation(sensitiveRef("agents:supply"), { value: SECRET }, optOut as never)).rejects.toMatchObject({ code: "BAD_REQUEST" });

        expect(server.bodies.join("")).not.toContain(SECRET);

        client.close();
    });

    it("types onlineOnly: false as an error on a sensitive reference, and leaves plain references alone", () => {
        expect.hasAssertions();

        // Compile-time only: the thunks are type-checked and never run, so no call
        // reaches a network. `@ts-expect-error` fails the type check if the option
        // ever stops being refused.
        const typeChecks = (client: LunoraClient): (() => Promise<unknown>)[] => [
            // @ts-expect-error -- a sensitive reference is always online-only; `false` is not a valid option
            () => client.mutation(sensitiveRef("agents:supply"), { value: SECRET }, { onlineOnly: false }),
            () => client.mutation(sensitiveRef("agents:supply"), { value: SECRET }, { onlineOnly: true }),
            () => client.mutation(sensitiveRef("agents:supply"), { value: SECRET }),
            () => client.mutation(plainRef("todos.set"), { value: SECRET }, { onlineOnly: false }),
        ];

        expect(typeChecks).toBeTypeOf("function");
    });
});

import { vi } from "vitest";

import { LunoraClient } from "../../src/lunora-client";
import type { FunctionReference, PersistenceAdapter } from "../../src/types";

/** A scriptable WebSocket double: the test decides when it opens, what it receives and when it drops. */
export interface HarnessSocket {
    close: () => void;
    /** Parsed control frames sent on this socket, minus `connect` and keepalive pings. */
    frames: () => { id?: string; type: string }[];
    open: () => void;
    readyState: number;
    receive: (payload: unknown) => void;
    sent: string[];
    triggerClose: () => void;
    url: string;
}

export const fnRef = (reference: string): FunctionReference => {
    return { __lunoraRef: reference };
};

export const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    Response.json(body, { headers: { "content-type": "application/json" }, status: 200, ...init });

/** Drain pending microtasks and any timer due now (fake timers must be installed). */
export const settle = async (): Promise<void> => {
    for (let index = 0; index < 8; index += 1) {
        // eslint-disable-next-line no-await-in-loop -- intentional sequential drain of promise ticks
        await vi.advanceTimersByTimeAsync(0);
    }
};

export const createSocketHarness = (): { sockets: HarnessSocket[]; WebSocket: typeof WebSocket } => {
    const sockets: HarnessSocket[] = [];

    class WS {
        public readyState = 0;

        public sent: string[] = [];

        public onclose: ((event?: unknown) => void) | null = null;

        public onerror: ((event?: unknown) => void) | null = null;

        public onmessage: ((event: { data: unknown }) => void) | null = null;

        public onopen: ((event?: unknown) => void) | null = null;

        public readonly url: string;

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(url: string) {
            this.url = url;
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            const existing = this.listeners.get(type) ?? [];

            existing.push(listener);
            this.listeners.set(type, existing);
        }

        public removeEventListener(type: string): void {
            this.listeners.delete(type);
        }

        public close(): void {
            this.readyState = 3;
        }

        public frames(): { id?: string; type: string }[] {
            return this.sent
                .filter((frame) => frame !== "lunora-ping")
                .map((frame) => JSON.parse(frame) as { id?: string; type: string })
                .filter((frame) => frame.type !== "connect");
        }

        public open(): void {
            this.readyState = 1;
            this.onopen?.();
            this.dispatch("open");
        }

        public receive(payload: unknown): void {
            const data = typeof payload === "string" ? payload : JSON.stringify(payload);

            this.onmessage?.({ data });
            this.dispatch("message", { data });
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.onclose?.();
            this.dispatch("close");
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return { sockets, WebSocket: WS as unknown as typeof WebSocket };
};

/** A client that queues writes before its first connect, persisting them to `persistence`. Subscribes to `todos.list` unless `subscribe` is false. */
export const createQueueingClient = (
    persistence: PersistenceAdapter,
    { subscribe = true }: { subscribe?: boolean } = {},
    fetchImpl: typeof fetch = vi.fn<typeof fetch>(async () => jsonResponse({ result: { ok: true } })),
): { client: LunoraClient; fetchImpl: typeof fetch; sockets: HarnessSocket[] } => {
    const { sockets, WebSocket } = createSocketHarness();
    const client = new LunoraClient({
        fetch: fetchImpl,
        heartbeatIntervalMs: 0,
        offlineQueue: { queueBeforeFirstConnect: true },
        persistence,
        url: "http://app.test",
        WebSocket,
    });

    if (subscribe) {
        client.subscribe(fnRef("todos.list"), {}, () => undefined);
    }

    return { client, fetchImpl, sockets };
};

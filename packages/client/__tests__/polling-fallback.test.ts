import { afterEach, describe, expect, it, vi } from "vitest";

import { LunoraClient } from "../src/lunora-client";
import { createPollingFallback } from "../src/polling-fallback";
import type { FunctionReference } from "../src/types";

/**
 * The HTTP polling fallback: what keeps live queries moving on a network that
 * refuses the WebSocket upgrade. Two layers are covered here — the state machine
 * on its own (thresholds, overlap, reset), and the client wiring that decides
 * when it engages and where the polled values land.
 */

// --- The state machine ------------------------------------------------------

describe("createPollingFallback", () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it("does not poll until the failed-open run reaches the threshold", () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const poll = vi.fn<() => Promise<void>>(async () => {});
        const fallback = createPollingFallback({ afterFailedAttempts: 3, intervalMs: 1000, onStateChange: () => {}, poll });

        fallback.noteFailedOpen();
        fallback.noteFailedOpen();
        vi.advanceTimersByTime(5000);

        expect(poll).not.toHaveBeenCalled();
        expect(fallback.isPolling()).toBe(false);
    });

    it("polls immediately at the threshold, then on the interval", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const poll = vi.fn<() => Promise<void>>(async () => {});
        const fallback = createPollingFallback({ afterFailedAttempts: 2, intervalMs: 1000, onStateChange: () => {}, poll });

        fallback.noteFailedOpen();
        fallback.noteFailedOpen();

        // Immediately, not after a full interval: by this point the subscriptions
        // have already been stale across every failed attempt.
        expect(poll).toHaveBeenCalledTimes(1);

        // `...Async` deliberately: each pass only clears its in-flight flag in a
        // `.finally()` microtask, so a synchronous advance would fire the next two
        // timers into the overlap guard and observe ONE call. That is the guard
        // working, but it is not what this test is about.
        await vi.advanceTimersByTimeAsync(2500);

        expect(poll).toHaveBeenCalledTimes(3);
        expect(fallback.isPolling()).toBe(true);
    });

    it("stops polling and forgets the run once a socket opens", () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const poll = vi.fn<() => Promise<void>>(async () => {});
        const fallback = createPollingFallback({ afterFailedAttempts: 2, intervalMs: 1000, onStateChange: () => {}, poll });

        fallback.noteFailedOpen();
        fallback.noteFailedOpen();
        fallback.noteOpen();

        expect(fallback.isPolling()).toBe(false);

        vi.advanceTimersByTime(5000);

        expect(poll).toHaveBeenCalledTimes(1);

        // The run was reset, so a single later failure does not re-engage it.
        fallback.noteFailedOpen();

        expect(fallback.isPolling()).toBe(false);
    });

    it("never overlaps two passes when a poll outlives the interval", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        let release = (): void => {};
        const poll = vi.fn<() => Promise<void>>(
            async () =>
                new Promise<void>((resolve) => {
                    release = resolve;
                }),
        );
        const fallback = createPollingFallback({ afterFailedAttempts: 1, intervalMs: 100, onStateChange: () => {}, poll });

        fallback.noteFailedOpen();
        vi.advanceTimersByTime(1000);

        // Ten ticks fired while the first pass was still in flight; stacking
        // requests on the link that is already the reason we are here is exactly
        // what must not happen.
        expect(poll).toHaveBeenCalledTimes(1);

        release();
        await vi.advanceTimersByTimeAsync(100);

        expect(poll).toHaveBeenCalledTimes(2);
    });

    it("stays inert when the interval is zero", () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const poll = vi.fn<() => Promise<void>>(async () => {});
        const fallback = createPollingFallback({ afterFailedAttempts: 1, intervalMs: 0, onStateChange: () => {}, poll });

        fallback.noteFailedOpen();
        fallback.noteFailedOpen();
        vi.advanceTimersByTime(10_000);

        expect(poll).not.toHaveBeenCalled();
        expect(fallback.isPolling()).toBe(false);
    });
});

// --- The client wiring ------------------------------------------------------

interface MockSocket {
    close: () => void;
    open: () => void;
    triggerClose: () => void;
}

const sockets: MockSocket[] = [];

/** A socket that only opens when a test says so, so a refused upgrade is modelled exactly. */
const createMockWebSocket = (): typeof WebSocket => {
    class WS {
        public readyState = 0;

        public sent: string[] = [];

        private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

        public constructor(public readonly url: string) {
            sockets.push(this);
        }

        public addEventListener(type: string, listener: (event?: unknown) => void): void {
            this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
        }

        public close(): void {
            this.readyState = 3;
        }

        public open(): void {
            this.readyState = 1;
            this.dispatch("open");
        }

        public send(data: string): void {
            this.sent.push(data);
        }

        public triggerClose(): void {
            this.readyState = 3;
            this.dispatch("close");
        }

        private dispatch(type: string, event?: unknown): void {
            for (const listener of this.listeners.get(type) ?? []) {
                listener(event);
            }
        }
    }

    return WS as unknown as typeof WebSocket;
};

const fnRef = (ref: string): FunctionReference => {
    return { __lunoraRef: ref };
};

const jsonResponse = (body: unknown): Response => Response.json(body, { headers: { "content-type": "application/json" }, status: 200 });

/**
 * Reconnect settings that make an attempt deterministic and fast: no jitter and a
 * fixed 10ms backoff, so a test can step exactly one attempt at a time without
 * advancing far enough to trip the 10s connect timeout or a poll interval.
 */
const FAST_RECONNECT = { initialDelayMs: 10, jitter: false, maxDelayMs: 10 } as const;

/** One reconnect backoff step — long enough to arm the next socket, short enough to disturb nothing else. */
const STEP_MS = 20;

/** Drive `count` connect attempts that never reach `open`. */
const failOpens = async (count: number): Promise<void> => {
    for (let index = 0; index < count; index += 1) {
        sockets.at(-1)?.triggerClose();
        // eslint-disable-next-line no-await-in-loop -- each attempt must settle before the backoff timer for the next one is armed
        await vi.advanceTimersByTimeAsync(STEP_MS);
    }
};

describe("lunoraClient polling fallback", () => {
    afterEach(() => {
        vi.useRealTimers();
        sockets.length = 0;
    });

    it("refreshes a live query over batch RPC once the socket will not open", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [{ body: { result: { count: 7 } }, id: 0, status: 200 }] }));
        const client = new LunoraClient({
            fetch: fetchMock,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        const received: unknown[] = [];

        client.subscribe(fnRef("messages:list"), {}, (value) => received.push(value));

        await failOpens(2);

        expect(fetchMock).toHaveBeenCalledTimes(1);
        expect(fetchMock.mock.calls[0]?.[0] as string).toContain("/_lunora/rpc-batch");
        // The polled snapshot lands on the same path a server `data` frame takes.
        expect(received).toEqual([{ count: 7 }]);

        client.close();
    });

    it("reports `polling` so a UI can say live-but-degraded", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const client = new LunoraClient({
            fetch: vi.fn<typeof fetch>(async () => jsonResponse({ results: [] })),
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("messages:list"), {}, () => {});

        expect(client.connectionStatus()).toBe("connecting");

        await failOpens(2);

        expect(client.connectionStatus()).toBe("polling");

        client.close();
    });

    it("stops polling the moment a socket opens", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [{ body: { result: 1 }, id: 0, status: 200 }] }));
        const client = new LunoraClient({
            fetch: fetchMock,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("messages:list"), {}, () => {});

        await failOpens(2);

        const polledWhileDown = fetchMock.mock.calls.length;

        expect(polledWhileDown).toBeGreaterThan(0);

        sockets.at(-1)?.open();
        await vi.advanceTimersByTimeAsync(5000);

        expect(client.connectionStatus()).toBe("connected");
        // Not one more poll after the live channel came back.
        expect(fetchMock).toHaveBeenCalledTimes(polledWhileDown);

        client.close();
    });

    it("does not engage for a socket that opened and then dropped", async () => {
        expect.assertions(2);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [] }));
        const client = new LunoraClient({
            fetch: fetchMock,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.subscribe(fnRef("messages:list"), {}, () => {});

        // Open/drop three times — past the threshold, so only the "did it ever
        // open" test keeps polling off. A flaky link is the reconnect backoff's
        // job; trading a self-healing channel for a permanently slower one would
        // be a bad deal. The replacement socket is opened each round so no attempt
        // is left hanging in `connecting` (which WOULD be a failed open).
        for (let index = 0; index < 3; index += 1) {
            sockets.at(-1)?.open();
            sockets.at(-1)?.triggerClose();
            // eslint-disable-next-line no-await-in-loop -- each bounce must settle before the next backoff is armed
            await vi.advanceTimersByTimeAsync(STEP_MS);
        }

        sockets.at(-1)?.open();

        expect(client.connectionStatus()).not.toBe("polling");
        expect(fetchMock).not.toHaveBeenCalled();

        client.close();
    });

    // The fallback carries no admin exclusion, and that is the right answer: a
    // reserved `__lunora_admin__:*` subscription is an ordinary entry in the
    // subscription registry, and the batch RPC it is re-run over exempts the
    // admin prefix from `authorizeShard` and carries the client's auth token as
    // the bearer the DO's admin gate wants. So a studio panel whose socket is
    // refused degrades to a 5s poll rather than going dark — which is what makes
    // a refused admin upgrade a degradation, not an outage.
    it("polls a reserved admin subscription too, carrying the admin bearer", async () => {
        expect.assertions(3);

        vi.useFakeTimers();

        const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse({ results: [{ body: { result: { rows: [] } }, id: 0, status: 200 }] }));
        const client = new LunoraClient({
            fetch: fetchMock,
            pollingFallback: { afterFailedAttempts: 2, intervalMs: 1000 },
            reconnect: FAST_RECONNECT,
            url: "https://app.example",
            WebSocket: createMockWebSocket(),
        });

        client.setAuthToken("admin-bear");

        const received: unknown[] = [];

        client.subscribe(fnRef("__lunora_admin__:readTablePage"), { table: "messages" }, (value) => received.push(value));

        await failOpens(2);

        const init = fetchMock.mock.calls[0]?.[1];

        expect(fetchMock.mock.calls[0]?.[0] as string).toContain("/_lunora/rpc-batch");
        expect(new Headers(init?.headers).get("authorization")).toBe("Bearer admin-bear");
        expect(received).toStrictEqual([{ rows: [] }]);

        client.close();
    });
});

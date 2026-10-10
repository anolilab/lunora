import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WS_KEEPALIVE_PING } from "../src/client-paths";
import type { ManagedSocketState } from "../src/connection-state";
import { openManagedSocket } from "../src/managed-socket";

/** A WebSocket stand-in that records what was sent and lets a test fire its events. */
class FakeSocket {
    public static readonly instances: FakeSocket[] = [];

    public closed = false;

    public readonly sent: string[] = [];

    private readonly listeners = new Map<string, ((event?: unknown) => void)[]>();

    public constructor(public readonly url: string) {
        FakeSocket.instances.push(this);
    }

    public addEventListener(type: string, listener: (event?: unknown) => void): void {
        this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }

    public close(): void {
        this.closed = true;
    }

    public send(data: string): void {
        this.sent.push(data);
    }

    public fire(type: string, event?: unknown): void {
        for (const listener of this.listeners.get(type) ?? []) {
            listener(event);
        }
    }
}

const WebSocketImpl = FakeSocket as unknown as typeof WebSocket;

const freshConnection = (): ManagedSocketState => {
    return {
        connectTimer: undefined,
        heartbeatTimer: undefined,
        lastFrameAt: 0,
        socket: undefined,
    };
};

const lastSocket = (): FakeSocket => FakeSocket.instances.at(-1)!;

describe("managed socket lifecycle", () => {
    beforeEach(() => {
        vi.useFakeTimers();
        FakeSocket.instances.length = 0;
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it("sends a keepalive ping on each heartbeat interval once the socket is open", () => {
        expect.assertions(2);

        const conn = freshConnection();

        openManagedSocket(
            conn,
            "wss://app.example",
            { connectTimeoutMs: 1000, heartbeatIntervalMs: 100, WebSocketImpl },
            {
                onClose: () => undefined,
                onMessage: () => undefined,
            },
        );

        lastSocket().fire("open");
        vi.advanceTimersByTime(100);
        vi.advanceTimersByTime(100);

        expect(lastSocket().sent).toStrictEqual([WS_KEEPALIVE_PING, WS_KEEPALIVE_PING]);
        expect(lastSocket().closed).toBe(false);
    });

    it("force-closes a half-open socket once no frame has arrived for 2.5 heartbeat intervals", () => {
        expect.assertions(4);

        const conn = freshConnection();
        const onClose = vi.fn<(event?: { code?: number }) => void>();

        openManagedSocket(
            conn,
            "wss://app.example",
            { connectTimeoutMs: 1000, heartbeatIntervalMs: 100, WebSocketImpl },
            {
                onClose,
                onMessage: () => undefined,
            },
        );

        lastSocket().fire("open");

        // Just inside the window: still alive.
        vi.advanceTimersByTime(240);

        expect(lastSocket().closed).toBe(false);
        expect(onClose).not.toHaveBeenCalled();

        // Past 2.5 intervals with no frame: the watchdog closes it and reports it.
        vi.advanceTimersByTime(100);

        expect(lastSocket().closed).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("closes a socket that never reaches open within the connect timeout", () => {
        expect.assertions(3);

        const conn = freshConnection();
        const onClose = vi.fn<(event?: { code?: number }) => void>();

        openManagedSocket(
            conn,
            "wss://app.example",
            { connectTimeoutMs: 50, heartbeatIntervalMs: 0, WebSocketImpl },
            {
                onClose,
                onMessage: () => undefined,
            },
        );

        vi.advanceTimersByTime(49);

        expect(lastSocket().closed).toBe(false);

        vi.advanceTimersByTime(1);

        expect(lastSocket().closed).toBe(true);
        expect(onClose).toHaveBeenCalledTimes(1);
    });

    it("sends no keepalive when the heartbeat interval is zero", () => {
        expect.assertions(2);

        const conn = freshConnection();

        openManagedSocket(
            conn,
            "wss://app.example",
            { connectTimeoutMs: 1000, heartbeatIntervalMs: 0, WebSocketImpl },
            {
                onClose: () => undefined,
                onMessage: () => undefined,
            },
        );

        lastSocket().fire("open");
        vi.advanceTimersByTime(10_000);

        expect(lastSocket().sent).toStrictEqual([]);
        expect(lastSocket().closed).toBe(false);
    });
});

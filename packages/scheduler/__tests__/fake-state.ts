import type { SchedulerDOState } from "../src/scheduler-do.js";

export const createFakeState = (): SchedulerDOState & {
    alarm: number | null;
    storageMap: Map<string, unknown>;
} => {
    const storageMap = new Map<string, unknown>();
    let alarm: number | null = null;

    const state: SchedulerDOState & { alarm: number | null; storageMap: Map<string, unknown> } = {
        storageMap,
        get alarm() {
            return alarm;
        },
        set alarm(value: number | null) {
            alarm = value;
        },
        storage: {
            get: async <T = unknown>(key: string) => storageMap.get(key) as T | undefined,
            put: async <T = unknown>(entries: Record<string, T> | string, value?: T) => {
                if (typeof entries === "string") {
                    storageMap.set(entries, value as unknown);

                    return;
                }

                for (const [key, val] of Object.entries(entries)) {
                    storageMap.set(key, val);
                }
            },
            delete: async (keyOrKeys: string | string[]) => {
                const keys = Array.isArray(keyOrKeys) ? keyOrKeys : [keyOrKeys];
                let count = 0;

                for (const key of keys) {
                    if (storageMap.delete(key)) {
                        count += 1;
                    }
                }

                return count;
            },
            list: async <T = unknown>(options: { limit?: number; prefix?: string } = {}) => {
                const result = new Map<string, T>();
                const prefix = options.prefix ?? "";
                const keys = [...storageMap.keys()].filter((key) => key.startsWith(prefix)).sort();

                for (const key of keys.slice(0, options.limit ?? keys.length)) {
                    result.set(key, storageMap.get(key) as T);
                }

                return result;
            },
            setAlarm: async (time: number | Date) => {
                alarm = time instanceof Date ? time.getTime() : time;
            },
            getAlarm: async () => alarm,
            deleteAlarm: async () => {
                alarm = null;
            },
        },
    };

    return state;
};

/** A fake server WebSocket that records everything sent to it. */
export interface FakeSocket {
    close: () => void;
    send: (data: string) => void;
    readonly sent: string[];
}

export const createFakeSocket = (): FakeSocket => {
    const sent: string[] = [];

    return {
        sent,
        close: () => undefined,
        send: (data: string) => {
            sent.push(data);
        },
    };
};

/**
 * A storage fake plus the WebSocket hooks the live `/ws` channel needs:
 * `acceptWebSocket` records a socket and `getWebSockets` returns them, so
 * broadcast behaviour is testable without the workers runtime.
 */
export const createFakeStateWithSockets = (): ReturnType<typeof createFakeState> & { sockets: FakeSocket[] } => {
    const base = createFakeState();
    const sockets: FakeSocket[] = [];

    return Object.assign(base, {
        sockets,
        acceptWebSocket: (ws: WebSocket) => {
            sockets.push(ws as unknown as FakeSocket);
        },
        getWebSockets: () => sockets as unknown as WebSocket[],
    });
};

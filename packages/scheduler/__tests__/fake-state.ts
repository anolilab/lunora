import type { SchedulerDOState } from "../src/scheduler-do.js";

export const createFakeState = (): SchedulerDOState & {
    alarm: number | null;
    storageMap: Map<string, unknown>;
} => {
    const storageMap = new Map<string, unknown>();
    let alarm: number | null = null;

    const state: SchedulerDOState & { alarm: number | null; storageMap: Map<string, unknown> } = {
        get alarm() {
            return alarm;
        },
        set alarm(value: number | null) {
            alarm = value;
        },
        storage: {
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
            deleteAlarm: async () => {
                alarm = null;
            },
            get: async <T = unknown>(key: string) => storageMap.get(key) as T | undefined,
            getAlarm: async () => alarm,
            list: async <T = unknown>(options: { limit?: number; prefix?: string } = {}) => {
                const result = new Map<string, T>();
                const prefix = options.prefix ?? "";
                // Code-unit ordering (NOT locale-aware): the time index relies on
                // lexical byte order matching numeric order, so keep the default
                // string comparison rather than `localeCompare`.
                const keys = [...storageMap.keys()].filter((key) => key.startsWith(prefix)).toSorted((a, b) => a < b ? -1 : a > b ? 1 : 0);

                for (const key of keys.slice(0, options.limit ?? keys.length)) {
                    result.set(key, storageMap.get(key) as T);
                }

                return result;
            },
            put: async <T = unknown>(entries: Record<string, T> | string, value?: T) => {
                if (typeof entries === "string") {
                    storageMap.set(entries, value);

                    return;
                }

                for (const [key, value_] of Object.entries(entries)) {
                    storageMap.set(key, value_);
                }
            },
            setAlarm: async (time: number | Date) => {
                alarm = time instanceof Date ? time.getTime() : time;
            },
        },
        storageMap,
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
        close: () => undefined,
        send: (data: string) => {
            sent.push(data);
        },
        sent,
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
        acceptWebSocket: (ws: WebSocket) => {
            sockets.push(ws as unknown as FakeSocket);
        },
        getWebSockets: () => sockets as unknown as WebSocket[],
        sockets,
    });
};

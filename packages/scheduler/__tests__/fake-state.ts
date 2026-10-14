import type { SchedulerDOState } from "../src/scheduler-do";

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
            list: async <T = unknown>(options: { end?: string; limit?: number; prefix?: string; startAfter?: string } = {}) => {
                const result = new Map<string, T>();
                const prefix = options.prefix ?? "";
                // Code-unit ordering (NOT locale-aware): the time index relies on
                // lexical byte order matching numeric order, so keep the default
                // string comparison rather than `localeCompare`.
                const byteCompare = (left: string, right: string): number => {
                    if (left < right) {
                        return -1;
                    }

                    return left > right ? 1 : 0;
                };
                let keys = [...storageMap.keys()].filter((key) => key.startsWith(prefix)).toSorted(byteCompare);

                // `startAfter` (a cursor pagination page's "resume after this key")
                // mirrors the real Durable Object storage.list() option, used by
                // SchedulerDO's countHeaders() to page through the header set with
                // bounded memory instead of one unlimited list.
                if (options.startAfter !== undefined) {
                    const { startAfter } = options;

                    keys = keys.filter((key) => byteCompare(key, startAfter) > 0);
                }

                // `end` is the EXCLUSIVE upper bound, matching the real Durable
                // Object storage.list(). Modelling it is not optional detail: the
                // alarm path bounds its due-slice with `end: t:<paddedNow>:~`, so a
                // fake that ignores `end` silently returns rows the real runtime
                // would never hand back — and every bug that turns on a key sorting
                // outside that bound becomes invisible to this whole suite.
                if (options.end !== undefined) {
                    const { end } = options;

                    keys = keys.filter((key) => byteCompare(key, end) < 0);
                }

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

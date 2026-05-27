import type { SchedulerDOState } from "../src/SchedulerDO.js";

export const createFakeState = (): SchedulerDOState & {
    storageMap: Map<string, unknown>;
    alarm: number | null;
} => {
    const storageMap = new Map<string, unknown>();
    let alarm: number | null = null;

    const state: SchedulerDOState & { storageMap: Map<string, unknown>; alarm: number | null } = {
        storageMap,
        get alarm() {
            return alarm;
        },
        set alarm(value: number | null) {
            alarm = value;
        },
        storage: {
            get: async <T = unknown,>(key: string) => storageMap.get(key) as T | undefined,
            put: async <T = unknown,>(entries: Record<string, T> | string, value?: T) => {
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
            list: async <T = unknown,>(options: { prefix?: string; limit?: number } = {}) => {
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

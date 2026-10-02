/**
 * A minimal fake of the Durable Object ctx `@cloudflare/containers` reads, for
 * suites that construct a `LunoraContainer` in Node. Mirrors the one inline in
 * `lunora-container.test.ts`, plus `exports` for the sandbox gateways.
 */
const fakeDurableObjectContext = (container: unknown, exports: Record<string, unknown> = {}): Record<string, unknown> => {
    const stored = new Map<string, unknown>();

    return {
        // The base ctor schedules alarms inside an un-awaited critical section;
        // accept the callback without running it (see lunora-container.test.ts).
        blockConcurrencyWhile: async () => {},
        // The base ctor monitors a container it finds running; a monitor that
        // never settles is a container that never exits on its own.
        container: { monitor: async () => new Promise<void>(() => {}), ...(container as object) },
        exports,
        storage: {
            delete: async (keys: string | string[]) => {
                for (const key of Array.isArray(keys) ? keys : [keys]) {
                    stored.delete(key);
                }
            },
            deleteAlarm: async () => {},
            get: async (key: string) => stored.get(key),
            getAlarm: async () => null,
            kv: { delete: () => {}, get: () => undefined, put: () => {} },
            put: async (key: string, value: unknown) => {
                stored.set(key, value);
            },
            setAlarm: async () => {},
            sql: { exec: () => Object.assign([], { one: () => undefined, raw: () => [], toArray: () => [] }) },
        },
    };
};

/** A stream that yields `text` once. */
const streamOf = (text: string): ReadableStream<Uint8Array> =>
    new ReadableStream({
        start(controller) {
            controller.enqueue(new TextEncoder().encode(text));
            controller.close();
        },
    });

export { fakeDurableObjectContext, streamOf };

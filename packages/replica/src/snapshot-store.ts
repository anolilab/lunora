/**
 * Interface for persisting event-sourced state snapshots.
 *
 * In a Lunora app the primary implementation is backed by the
 * SnapshotDO (a Durable Object) on the server side. On the client
 * the {@link InMemorySnapshotStore} is used for the offline-first
 * local mirror, while a production client would implement this
 * over IndexedDB or OPFS.
 * @experimental
 */
export interface SnapshotStore {
    /** Delete all snapshots. */
    clear: () => Promise<void>;

    /** Delete a single snapshot. */
    delete: (key: string) => Promise<void>;

    /** List all snapshot keys. */
    list: () => Promise<string[]>;

    /** Load a previously saved snapshot, or `null` when not found. */
    load: (key: string) => Promise<unknown>;

    /** Persist a snapshot under `key`. */
    save: (key: string, snapshot: unknown) => Promise<void>;
}

// ── InMemorySnapshotStore ──────────────────────────────────────────────

/**
 * In-memory snapshot store. Useful for testing and for the local
 * offline-first mirror where persistence is handled at a higher
 * layer (IndexedDB adapter).
 * @experimental
 */
export class InMemorySnapshotStore implements SnapshotStore {
    readonly #store = new Map<string, unknown>();

    public save(key: string, snapshot: unknown): Promise<void> {
        this.#store.set(key, structuredClone(snapshot));

        return Promise.resolve();
    }

    public load(key: string): Promise<unknown> {
        const value = this.#store.get(key);

        // The SnapshotStore contract intentionally uses `null` to mean
        // "missing" so callers can distinguish a stored `undefined` from
        // a missing key.
        // eslint-disable-next-line unicorn/no-null
        return Promise.resolve(value === undefined ? null : structuredClone(value));
    }

    public list(): Promise<string[]> {
        return Promise.resolve([...this.#store.keys()]);
    }

    public delete(key: string): Promise<void> {
        this.#store.delete(key);

        return Promise.resolve();
    }

    public clear(): Promise<void> {
        this.#store.clear();

        return Promise.resolve();
    }
}

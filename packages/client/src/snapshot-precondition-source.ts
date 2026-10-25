/** The live query a snapshot precondition compares against. */
interface SnapshotSource {
    readonly args: Record<string, unknown>;
    readonly functionPath: string;
    readonly shardKey: string | undefined;
}

/**
 * Snapshot preconditions keyed by their function. A side channel, because the
 * public contract is `() => boolean`, and a boolean cannot say "not decidable
 * yet": the offline queue needs to know which subscription a write's guard reads,
 * so it can hold the write until that subscription is answered on the new socket.
 */
const sources = new WeakMap<() => boolean, SnapshotSource>();

const registerSnapshotSource = (precondition: () => boolean, source: SnapshotSource): void => {
    sources.set(precondition, source);
};

const snapshotSourceOf = (precondition: (() => boolean) | undefined): SnapshotSource | undefined =>
    precondition === undefined ? undefined : sources.get(precondition);

export type { SnapshotSource };
export { registerSnapshotSource, snapshotSourceOf };

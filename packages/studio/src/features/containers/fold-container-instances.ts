import type { LogEntry, LogLevel } from "../../lib/admin";

/**
 * The current lifecycle state of a container, derived from the most recent
 * lifecycle transition seen in the shard's log buffer. `unknown` covers a
 * transition token the buffer folds but this view doesn't map.
 */
type ContainerLifecycleState = "error" | "running" | "sleeping" | "stopped" | "unknown";

/** The `functionPath` prefix `@lunora/do` tags every container lifecycle log entry with. */
const CONTAINER_LOG_PREFIX = "container:";

/** Maps a raw lifecycle transition token (from the log message) to a current-state label. */
const EVENT_STATE: Record<string, ContainerLifecycleState> = {
    error: "error",
    sleep: "sleeping",
    start: "running",
    stop: "stopped",
};

/**
 * One container instance's current state, folded from its latest lifecycle
 * transition.
 *
 * The log envelope now carries the per-instance Durable Object id
 * (`entry.instance`) and, for a `stop`, the process `exitCode`; `@lunora/do`
 * maps the Container DO's best-effort lifecycle push to `functionPath:
 * "container:&lt;name>"` + a `&lt;event>` / `&lt;event>: &lt;detail>` message. So this view
 * is keyed per `(name, instance)` — many concurrent instances of one container
 * fold into their own rows instead of collapsing into a single lane. An entry
 * with no instance id (older buffers, or a pre-instance transition) folds under
 * a synthetic single-lane key so it still renders.
 */
interface ContainerInstanceRow {
    /** Detail after the `&lt;event>:` marker (a stop reason / error message), when present. */
    readonly detail?: string;
    /** The raw lifecycle transition token that produced the current state (`start`/`stop`/`sleep`/`error`). */
    readonly event: string;
    /** Process exit code, present on a `stop` transition that carried one. */
    readonly exitCode?: number;
    /** The per-instance Durable Object id, when the envelope carried one. */
    readonly instance?: string;
    /** Buffer severity of the last transition. */
    readonly level: LogLevel;
    /** The `lunora/containers.ts` export name. */
    readonly name: string;
    /** Current lifecycle state, derived from the last transition. */
    readonly state: ContainerLifecycleState;
    /** Epoch-ms of the last transition. */
    readonly timestamp: number;
}

/**
 * Split a folded container log message into its transition token + optional
 * detail. `@lunora/do` writes `"&lt;event>"` or `"&lt;event>: &lt;detail>"` (e.g.
 * `"stop: hard timeout reached"`), so the first `:` bounds the token.
 */
const parseContainerMessage = (message: string): { detail?: string; event: string } => {
    const separator = message.indexOf(":");

    if (separator === -1) {
        return { event: message.trim() };
    }

    const detail = message.slice(separator + 1).trim();
    const event = message.slice(0, separator).trim();

    // Omit `detail` entirely (rather than setting it `undefined`) when empty, so
    // the shape is `{ event }` for a detail-less transition.
    return detail === "" ? { event } : { detail, event };
};

/**
 * Reduce a shard's log entries (newest-first, as `getLogs` returns them) to the
 * current state of each container instance — the panel's "current containers"
 * view. Only `container:&lt;name>` entries are considered; rows are keyed per
 * `(name, instance)` so concurrent instances stay distinct, and for each key the
 * entry with the greatest timestamp wins. An entry with no instance id folds
 * under the container name alone. Pure + order-independent, so it is
 * unit-testable in isolation and stable regardless of the buffer's ordering.
 */
const foldContainerInstances = (entries: ReadonlyArray<LogEntry>): ContainerInstanceRow[] => {
    const latest = new Map<string, ContainerInstanceRow>();

    for (const entry of entries) {
        const path = entry.functionPath ?? "";

        if (!path.startsWith(CONTAINER_LOG_PREFIX)) {
            continue;
        }

        const name = path.slice(CONTAINER_LOG_PREFIX.length);

        if (name === "") {
            continue;
        }

        // Key per `(name, instance)` so many concurrent instances of one
        // container fold into their own rows. JSON-encode the pair so no name /
        // instance combination can collide with a different one.
        const key = JSON.stringify([name, entry.instance ?? ""]);
        const previous = latest.get(key);

        if (previous !== undefined && previous.timestamp >= entry.timestamp) {
            continue;
        }

        const { detail, event } = parseContainerMessage(entry.message);

        latest.set(key, {
            detail,
            event,
            exitCode: entry.exitCode,
            instance: entry.instance,
            level: entry.level,
            name,
            state: EVENT_STATE[event] ?? "unknown",
            timestamp: entry.timestamp,
        });
    }

    // Group by container name, then by instance id, so the panel lists each
    // container's instances together in a stable order.
    return [...latest.values()].toSorted((a, b) => a.name.localeCompare(b.name) || (a.instance ?? "").localeCompare(b.instance ?? ""));
};

export { CONTAINER_LOG_PREFIX, foldContainerInstances, parseContainerMessage };
export type { ContainerInstanceRow, ContainerLifecycleState };

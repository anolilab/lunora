/**
 * Emit a Cirrus-tagged lifecycle event for a container instance.
 *
 * The generated Container DO classes call this on start/stop/error so the dev
 * log stream can surface container lifecycle — correlated by instance — in the
 * same terminal as `ctx.log` and RPC lines. The envelope mirrors the
 * `source: "cirrus"` shape `@cirrus/do` emits for request/log events, so
 * `@cirrus/config`'s `formatCirrusEvent` formats it without a new transport.
 *
 * Node-safe (just `console`), so it's importable by the workerd-only DO entry
 * and unit-testable by spying `console`.
 */

/** A container lifecycle transition worth a log line. */
type ContainerLifecycle = "error" | "start" | "stop";

/** The `source` tag every Cirrus console event carries (mirrors `CIRRUS_EVENT_SOURCE`). */
const CIRRUS_EVENT_SOURCE = "cirrus";

/**
 * The structured `type: "container"` cirrus event one lifecycle transition
 * produces. The single envelope feeds BOTH the terminal (printed by
 * {@link emitContainerLifecycle}, formatted by `@cirrus/config`'s
 * `formatCirrusEvent`) and the best-effort push into the ShardDO `LogBuffer`
 * (the Studio Logs panel), so the two views can never diverge.
 */
interface ContainerLifecycleEvent {
    /** The `cirrus/containers.ts` export name. */
    container: string;
    /** The lifecycle transition. */
    event: ContainerLifecycle;
    /** Per-instance correlation id (the Durable Object id / `CLOUDFLARE_DURABLE_OBJECT_ID`). */
    instance: string;
    /** Severity — `"error"` for the error transition, `"info"` otherwise. */
    level: "error" | "info";
    /** Optional human-readable detail (an error message, the stop reason/exit code). */
    message?: string;
    /** The `source` tag every Cirrus console event carries. */
    source: typeof CIRRUS_EVENT_SOURCE;
    /** Epoch-ms the event was produced. */
    ts: number;
    /** Discriminator marking this as a container event. */
    type: "container";
}

/**
 * Build the structured lifecycle envelope for a container transition. Pure (no
 * I/O), so it can feed both the console print and the best-effort ShardDO push
 * from a single source of truth — the two never diverge.
 */
const buildContainerLifecycleEvent = (container: string, instance: string, event: ContainerLifecycle, message?: string): ContainerLifecycleEvent => {
    return {
        container,
        event,
        instance,
        level: event === "error" ? "error" : "info",
        message,
        source: CIRRUS_EVENT_SOURCE,
        ts: Date.now(),
        type: "container",
    };
};

/**
 * Print one `type: "container"` cirrus event. Errors go to `console.error` (so
 * they surface at the right severity even without the formatter); everything
 * else to `console.log`. `instance` is the per-instance correlation id (the
 * Durable Object id, a.k.a. the container's `CLOUDFLARE_DURABLE_OBJECT_ID`).
 *
 * Returns the envelope it printed so the caller can also forward it
 * (best-effort) to the ShardDO log buffer without rebuilding it.
 */
const emitContainerLifecycle = (container: string, instance: string, event: ContainerLifecycle, message?: string): ContainerLifecycleEvent => {
    const envelope = buildContainerLifecycleEvent(container, instance, event, message);
    const line = JSON.stringify(envelope);

    if (event === "error") {
        // eslint-disable-next-line no-console -- structured lifecycle event for the dev log stream
        console.error(line);
    } else {
        // eslint-disable-next-line no-console -- structured lifecycle event for the dev log stream
        console.log(line);
    }

    return envelope;
};

export type { ContainerLifecycle, ContainerLifecycleEvent };
export { buildContainerLifecycleEvent, CIRRUS_EVENT_SOURCE, emitContainerLifecycle };

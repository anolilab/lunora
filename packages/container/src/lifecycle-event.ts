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
 * Print one `type: "container"` cirrus event. Errors go to `console.error` (so
 * they surface at the right severity even without the formatter); everything
 * else to `console.log`. `instance` is the per-instance correlation id (the
 * Durable Object id, a.k.a. the container's `CLOUDFLARE_DURABLE_OBJECT_ID`).
 */
const emitContainerLifecycle = (container: string, instance: string, event: ContainerLifecycle, message?: string): void => {
    const line = JSON.stringify({
        container,
        event,
        instance,
        level: event === "error" ? "error" : "info",
        message,
        source: CIRRUS_EVENT_SOURCE,
        ts: Date.now(),
        type: "container",
    });

    if (event === "error") {
        // eslint-disable-next-line no-console -- structured lifecycle event for the dev log stream
        console.error(line);
    } else {
        // eslint-disable-next-line no-console -- structured lifecycle event for the dev log stream
        console.log(line);
    }
};

export type { ContainerLifecycle };
export { emitContainerLifecycle };

/**
 * Server-side product analytics for the control plane itself (GAPS.md E1 — the
 * studio observes tenants; nothing observed us).
 *
 * Plain `fetch` against PostHog's capture endpoint rather than `posthog-node`:
 * that SDK batches on a timer and flushes on process exit, and a Worker isolate
 * has neither — it is frozen between requests and torn down without notice, so
 * a batch queued during one request is simply lost. One request per event,
 * handed to `waitUntil`, is the shape that survives the runtime.
 *
 * Every call is best-effort and non-blocking. Analytics must never fail, slow,
 * or change the outcome of a deploy: a rejected capture is swallowed, and a
 * missing `POSTHOG_PROJECT_TOKEN` makes the whole module a no-op rather than an
 * error, so a cell without a PostHog project runs exactly as before.
 *
 * These events are about the PLATFORM, not about people. They are keyed on the
 * organization and the cell, never on an end user, and they carry ids and
 * outcomes — never a tenant's script contents, secret values, log lines, or
 * hostnames.
 */

/** Fields every server event carries, so a query can slice by cell without joining. */
interface ServerEventContext {
    /** This cell's name (`cells.name`), so a fleet-wide query can attribute a spike to one cell. */
    cell?: string;
    /** The organization the event is about. The `distinct_id` — the platform's unit of behaviour is a tenant, not a person. */
    organizationId: string;
}

/** The env this module reads. Structural, so the deploy router and the sweeps can both satisfy it. */
export interface AnalyticsEnv extends Record<string, unknown> {
    LUNORA_CELL?: string;
    POSTHOG_HOST?: string;
    POSTHOG_PROJECT_TOKEN?: string;
}

/** PostHog's default ingest host, used when a cell does not name its own (self-hosted) one. */
const DEFAULT_HOST = "https://eu.i.posthog.com";

/** Outbound cap. A hung analytics endpoint must not hold a `waitUntil` open behind it. */
const TIMEOUT_MS = 5000;

/**
 * Send one event, or do nothing when analytics is not configured.
 *
 * Returns a promise the caller is expected to hand to `ctx.waitUntil` rather
 * than await — the deploy that triggered it should not wait on telemetry, and
 * on workerd an un-awaited promise is cancelled at response time, so dropping
 * it entirely would silently send nothing.
 */
export const captureServerEvent = async (
    environment: AnalyticsEnv,
    event: string,
    context: ServerEventContext,
    properties: Record<string, boolean | number | string> = {},
): Promise<void> => {
    const token = environment.POSTHOG_PROJECT_TOKEN;

    if (typeof token !== "string" || token === "") {
        return;
    }

    const host = typeof environment.POSTHOG_HOST === "string" && environment.POSTHOG_HOST !== "" ? environment.POSTHOG_HOST : DEFAULT_HOST;

    try {
        // `new URL` with a RELATIVE path, against a base forced to end in "/".
        // Both halves matter: `URL` normalises however many trailing slashes the
        // configured host carries without a regex whose backtracking is its own
        // denial-of-service question, and a relative path preserves a host that
        // carries one — a first-party proxy like `https://cloud.example/ph` is a
        // supported shape, and an absolute "/i/v0/e/" would silently drop it.
        await fetch(new URL("i/v0/e/", host.endsWith("/") ? host : `${host}/`), {
            body: JSON.stringify({
                api_key: token,
                distinct_id: context.organizationId,
                event,
                properties: {
                    ...properties,
                    // Marks the event as coming from the control plane rather
                    // than the studio, so one project can hold both without the
                    // two sets of events being mistaken for each other.
                    $lib: "lunora-cloud-worker",
                    ...(context.cell === undefined ? {} : { cell: context.cell }),
                    organizationId: context.organizationId,
                },
                timestamp: new Date().toISOString(),
            }),
            headers: { "content-type": "application/json" },
            method: "POST",
            signal: AbortSignal.timeout(TIMEOUT_MS),
        });
    } catch {
        // Swallowed on purpose. This runs beside deploys, provisioning and the
        // billing sweeps; a telemetry endpoint being down must not turn into a
        // failed deploy or an unhandled rejection in a cron tick.
    }
};

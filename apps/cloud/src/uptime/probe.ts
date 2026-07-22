/**
 * Pure synthetic-uptime helpers for the Observability "watches while you sleep"
 * tier. Kept out of the sweep (which does the DB writes) and the edge (which
 * supplies the real `fetch`) so the probe outcome, the consecutive-failure state
 * machine, and the UI summary are unit-testable — mirroring how the alert
 * firing decision lives in the pure `src/telemetry/alerts.ts`.
 *
 * A deployment can't measure its own uptime — if it's down, it can't report that.
 * So the control plane probes each live deployment's URL from the outside, which
 * is the whole point of putting uptime here rather than in the runtime.
 */

/** Injectable clock so probe latency is deterministic under test; defaults to the wall clock. */
export type Clock = () => number;

/** The outcome of one external probe of a deployment URL. */
export interface UptimeProbe {
    /** Transport/timeout error message when the request never produced a response. */
    error?: string;
    /** Round-trip time of the probe, in ms. */
    latencyMs: number;
    /** `true` when the deployment answered with an HTTP status below 500. */
    ok: boolean;
    /** HTTP status, when a response came back. */
    statusCode?: number;
}

/** Default probe timeout — a deployment that hasn't answered in 10s counts as down. */
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Probe one deployment URL from the outside: a `GET` that counts as up on any
 * HTTP status below 500 (generalizing the deploy-time `healthCheck` in the deploy
 * router), with latency measured and a timeout that fails closed. A thrown fetch
 * (DNS, connection refused, timeout abort) is a down result carrying the message,
 * never a throw — the sweep must record every deployment's outcome.
 *
 * `redirect: "manual"` so a 3xx to a login/parking page reads as its own status
 * rather than being followed into a misleading 200.
 */
export const probeDeployment = async (options: { clock?: Clock; fetch: typeof globalThis.fetch; timeoutMs?: number; url: string }): Promise<UptimeProbe> => {
    const clock = options.clock ?? Date.now;
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => {
        controller.abort();
    }, timeoutMs);
    const started = clock();

    try {
        const response = await options.fetch(options.url, { method: "GET", redirect: "manual", signal: controller.signal });

        return { latencyMs: clock() - started, ok: response.status < 500, statusCode: response.status };
    } catch (error) {
        return {
            error: error instanceof Error ? error.message : "probe failed",
            latencyMs: clock() - started,
            ok: false,
        };
    } finally {
        clearTimeout(timer);
    }
};

/**
 * Advance a deployment's consecutive-failure counter: reset to 0 on a success,
 * otherwise increment. The alert engine fires on the count *crossing* a rule's
 * threshold (`crossesThreshold(previous, next, threshold)`), so this monotonic-
 * while-down / reset-on-recovery counter makes an uptime alert fire exactly once
 * per outage — the same "fires once" contract as issue/incident count crossings.
 */
export const nextConsecutiveFailures = (previous: number, ok: boolean): number => (ok ? 0 : previous + 1);

/** One stored probe result, as the summary reads them. */
export interface UptimeCheckSample {
    latencyMs?: number;
    ok: boolean;
}

/** A deployment's rolled-up uptime, for the dashboard's status cell. */
export interface UptimeSummary {
    /** Mean latency over the successful samples, or `undefined` when none succeeded. */
    avgLatencyMs?: number;
    /** Current status — the most recent sample's `ok` (true when there are no samples yet). */
    ok: boolean;
    /** Number of samples the summary covers. */
    sampleCount: number;
    /** Uptime as a fraction in `[0, 1]` over the samples; `1` when there are none. */
    upFraction: number;
}

/**
 * Summarize a deployment's recent checks into its status, uptime fraction, and
 * mean successful-probe latency. `checks` are newest-first (the order the reads
 * return them), so the current status is `checks[0]`. Empty → treated as up at
 * 100% (a deployment with no probes yet shouldn't read as down).
 */
export const summarizeUptime = (checks: readonly UptimeCheckSample[]): UptimeSummary => {
    if (checks.length === 0) {
        return { ok: true, sampleCount: 0, upFraction: 1 };
    }

    const up = checks.filter((check) => check.ok);
    const latencies = up.map((check) => check.latencyMs).filter((ms): ms is number => typeof ms === "number");
    const avgLatencyMs = latencies.length === 0 ? undefined : latencies.reduce((sum, ms) => sum + ms, 0) / latencies.length;

    return {
        ...(avgLatencyMs === undefined ? {} : { avgLatencyMs }),
        ok: checks[0]?.ok ?? true,
        sampleCount: checks.length,
        upFraction: up.length / checks.length,
    };
};

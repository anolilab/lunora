/**
 * The shared `/_lunora/health` probe used by `lunora verify --health-url` and
 * `lunora deploy --health-check`.
 *
 * Both commands ask the same question — "does this deployment answer?" — so
 * they ask it through one implementation with one error-message shape. The
 * runtime auto-registers both routes (`packages/runtime/src/health-routes.ts`):
 * `/_lunora/health/ready` is the readiness gate ("can this version serve"), and
 * `/_lunora/health` is the aggregate that also exists on older deployments.
 *
 * The probe is transport-only: it never throws, and reports its verdict as an
 * `{ error }` message the caller decides what to do with.
 */

/**
 * Minimal fetch surface the probe needs — a subset of the global `fetch`,
 * injectable so a test can feed a canned response without a network.
 */
type HealthFetch = (url: string) => Promise<{ ok: boolean; status: number }>;

/** The aggregate health route: reports every critical dependency (503 when one is down). */
const HEALTH_PATH = "/_lunora/health";

/** The readiness gate: "can this version serve traffic". Absent on older deployments (404). */
const HEALTH_READY_PATH = "/_lunora/health/ready";

/** Join a base URL and a health path without doubling the slash. */
const joinHealthUrl = (base: string, path: string = HEALTH_PATH): string => (base.endsWith("/") ? base.slice(0, -1) : base) + path;

interface HealthProbeInputs {
    /**
     * How many times to ask before giving up. Defaults to a single attempt (the
     * `verify` behaviour); a fresh deploy passes more, because propagation makes
     * one immediate probe a coin flip.
     */
    attempts?: number;
    /** The deployment's origin (with or without a trailing slash). */
    baseUrl: string;
    /** Fixed delay between attempts, in ms. Not exponential — a predictable ceiling is what a CI timeout is set against. */
    delayMs?: number;
    /** Injectable fetch; defaults to the global `fetch`. */
    fetchImpl?: HealthFetch;

    /**
     * Health paths to try in order. A `404` on one falls through to the next
     * (the route doesn't exist on that deployment); any other non-2xx is a real
     * failure. Defaults to the aggregate route alone.
     */
    paths?: ReadonlyArray<string>;
    /** Injectable clock for the inter-attempt delay; defaults to a real timer. */
    sleep?: (ms: number) => Promise<void>;

    /**
     * Per-attempt timeout, in ms. Applies only to the default fetch — an
     * injected `fetchImpl` owns its own deadline. Without it a stalled
     * connection would hang the probe indefinitely, since Node's `fetch` has no
     * timeout of its own.
     */
    timeoutMs?: number;
}

interface HealthProbeResult {
    /** The failure reason, absent when the probe is green. */
    error?: string;
    /** The URL the verdict came from — the last one tried. */
    url: string;
}

/** Try each path once, in order. A 404 falls through to the next path; anything else is the verdict. */
const probeOnce = async (baseUrl: string, paths: ReadonlyArray<string>, fetchImpl: HealthFetch): Promise<HealthProbeResult> => {
    let last: HealthProbeResult = { error: `health probe failed: no health path configured for ${baseUrl}`, url: baseUrl };

    for (const [index, path] of paths.entries()) {
        const url = joinHealthUrl(baseUrl, path);
        let response: { ok: boolean; status: number };

        try {
            // eslint-disable-next-line no-await-in-loop -- sequential fallback: the next path is only tried when this one 404s
            response = await fetchImpl(url);
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return { error: `health probe failed: could not reach ${url} (${message})`, url };
        }

        if (response.ok) {
            return { url };
        }

        last = { error: `health probe failed: ${url} returned HTTP ${String(response.status)}`, url };

        // A 404 means this deployment doesn't mount that route (an older
        // runtime has no readiness gate) — fall through to the next path.
        if (response.status !== 404 || index === paths.length - 1) {
            return last;
        }
    }

    return last;
};

const realSleep = async (ms: number): Promise<void> =>
    new Promise((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Probe a deployment's health route(s), retrying up to `attempts` times with a
 * fixed `delayMs` between tries. A `2xx` is green; a `503` (a critical
 * dependency down), any other non-2xx, and a transport failure are red. Returns
 * the last verdict — `{ url }` on green, `{ error, url }` on red.
 */
const probeHealth = async ({
    attempts = 1,
    baseUrl,
    delayMs = 2000,
    fetchImpl,
    paths = [HEALTH_PATH],
    sleep = realSleep,
    timeoutMs = 10_000,
}: HealthProbeInputs): Promise<HealthProbeResult> => {
    // Node's `fetch` never times out on its own: a worker that accepts the
    // connection and then goes quiet would hang the probe — and with it
    // `deploy --health-check` — until CI's job timeout killed it. That defeats
    // the whole point of a fixed attempt budget, so bound every attempt. An
    // abort surfaces as a transport error, which `probeOnce` already reds.
    const doFetch = fetchImpl ?? ((url: string) => fetch(url, { signal: AbortSignal.timeout(timeoutMs) }));
    const budget = Math.max(1, attempts);
    let result = await probeOnce(baseUrl, paths, doFetch);

    for (let attempt = 1; attempt < budget && result.error !== undefined; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a retry is sequential by definition
        await sleep(delayMs);
        // eslint-disable-next-line no-await-in-loop -- same
        result = await probeOnce(baseUrl, paths, doFetch);
    }

    return result;
};

export type { HealthFetch, HealthProbeInputs, HealthProbeResult };
export { HEALTH_PATH, HEALTH_READY_PATH, joinHealthUrl, probeHealth };

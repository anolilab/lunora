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
 * `headers` is read only for a redirect's `location`.
 */
type HealthFetch = (
    url: string,
    init: { headers: Record<string, string>; redirect: "manual" },
) => Promise<{ headers?: { get: (name: string) => string | null }; ok: boolean; status: number }>;

/** The Cloudflare Access service-token variables the probe sends, when both are set. */
const ACCESS_CLIENT_ID_ENV = "CF_ACCESS_CLIENT_ID";

const ACCESS_CLIENT_SECRET_ENV = "CF_ACCESS_CLIENT_SECRET";

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

    /**
     * Where {@link ACCESS_CLIENT_ID_ENV} / {@link ACCESS_CLIENT_SECRET_ENV} are
     * read from; defaults to `process.env`. With both set, every probe request
     * carries them as `CF-Access-Client-Id` / `CF-Access-Client-Secret`, so a
     * deployment behind Cloudflare Access answers.
     */
    env?: Readonly<Record<string, string | undefined>>;
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

/** The Access credentials as request headers, or why none are sent. */
interface AccessHeaders {
    headers: Record<string, string>;
    /** Set when exactly one of the two variables is, so the Access hint can say which one is missing. */
    missing?: string;
}

const accessHeaders = (env: Readonly<Record<string, string | undefined>>): AccessHeaders => {
    const clientId = env[ACCESS_CLIENT_ID_ENV] ?? "";
    const clientSecret = env[ACCESS_CLIENT_SECRET_ENV] ?? "";

    if (clientId !== "" && clientSecret !== "") {
        return { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret } };
    }

    if (clientId === "" && clientSecret === "") {
        return { headers: {} };
    }

    return { headers: {}, missing: clientId === "" ? ACCESS_CLIENT_ID_ENV : ACCESS_CLIENT_SECRET_ENV };
};

/** Whether `location` is Cloudflare Access's login: its team domain, or the `/cdn-cgi/access/` path on the app's own host. */
const isAccessLogin = (location: string, url: string): boolean => {
    try {
        const target = new URL(location, url);

        return target.hostname.endsWith(".cloudflareaccess.com") || target.pathname.startsWith("/cdn-cgi/access/");
    } catch {
        return false;
    }
};

/** The verdict on a non-2xx answer, naming Cloudflare Access when it is what answered. */
const failureMessage = (url: string, response: Awaited<ReturnType<HealthFetch>>, access: AccessHeaders): string => {
    const status = `health probe failed: ${url} returned HTTP ${String(response.status)}`;
    const sent = Object.keys(access.headers).length > 0;

    if (response.status >= 300 && response.status < 400) {
        const location = response.headers?.get("location") ?? "";

        if (!isAccessLogin(location, url)) {
            return `${status}${location === "" ? "" : ` redirecting to ${location}`} — the health route does not redirect, so something in front of the Worker answered.`;
        }

        if (sent) {
            return `${status}: Cloudflare Access refused the service token in ${ACCESS_CLIENT_ID_ENV} / ${ACCESS_CLIENT_SECRET_ENV} and redirected to its login. Check that the Access application has a Service Auth policy that includes this token.`;
        }

        const set = access.missing === undefined ? "Set" : `Only one of the two is set; set ${access.missing} too, so both`;

        return `${status}: the host is behind Cloudflare Access, which redirected the probe to its login. ${set} ${ACCESS_CLIENT_ID_ENV} and ${ACCESS_CLIENT_SECRET_ENV} to a service token the Access application allows (a Service Auth policy), and the probe sends them.`;
    }

    // Access answers a service token it rejects with 403 rather than a login redirect.
    return sent && (response.status === 401 || response.status === 403)
        ? `${status} with the Cloudflare Access service token from ${ACCESS_CLIENT_ID_ENV} / ${ACCESS_CLIENT_SECRET_ENV} sent — if the host is behind Access, check that the token is current and a Service Auth policy includes it.`
        : status;
};

/** Try each path once, in order. A 404 falls through to the next path; anything else is the verdict. */
const probeOnce = async (baseUrl: string, paths: ReadonlyArray<string>, fetchImpl: HealthFetch, access: AccessHeaders): Promise<HealthProbeResult> => {
    let last: HealthProbeResult = { error: `health probe failed: no health path configured for ${baseUrl}`, url: baseUrl };

    for (const [index, path] of paths.entries()) {
        const url = joinHealthUrl(baseUrl, path);
        let response: Awaited<ReturnType<HealthFetch>>;

        try {
            // A redirect is never followed: fetch would forward the Access headers to wherever it points, and an Access login page
            // that answers 200 would read as a healthy deployment.
            // eslint-disable-next-line no-await-in-loop -- sequential fallback: the next path is only tried when this one 404s
            response = await fetchImpl(url, { headers: access.headers, redirect: "manual" });
        } catch (error: unknown) {
            const message = error instanceof Error ? error.message : String(error);

            return { error: `health probe failed: could not reach ${url} (${message})`, url };
        }

        if (response.ok) {
            return { url };
        }

        last = { error: failureMessage(url, response, access), url };

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
    env = process.env,
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
    const doFetch: HealthFetch = fetchImpl ?? (async (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }));
    const access = accessHeaders(env);
    const budget = Math.max(1, attempts);
    let result = await probeOnce(baseUrl, paths, doFetch, access);

    for (let attempt = 1; attempt < budget && result.error !== undefined; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a retry is sequential by definition
        await sleep(delayMs);
        // eslint-disable-next-line no-await-in-loop -- same
        result = await probeOnce(baseUrl, paths, doFetch, access);
    }

    return result;
};

export type { HealthFetch };
export { HEALTH_PATH, HEALTH_READY_PATH, joinHealthUrl, probeHealth };

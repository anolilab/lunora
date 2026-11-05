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
 * The fetch surface the probe needs — a subset of the global `fetch`,
 * injectable so a test can feed a canned response without a network. The
 * response's `headers` are read for a redirect's `location`.
 */
type HealthFetch = (
    url: string,
    init: { headers: Record<string, string>; redirect: RequestRedirect },
) => Promise<{ headers: { get: (name: string) => string | null }; ok: boolean; status: number }>;

type HealthResponse = Awaited<ReturnType<HealthFetch>>;

/** The Cloudflare Access service-token id the probe sends as `CF-Access-Client-Id`. */
const ACCESS_CLIENT_ID_ENV = "CF_ACCESS_CLIENT_ID";

/** The Cloudflare Access service-token secret the probe sends as `CF-Access-Client-Secret`. */
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
     * read from; defaults to `process.env`. With both set, every `https:` probe
     * request carries them as `CF-Access-Client-Id` / `CF-Access-Client-Secret`,
     * so a deployment behind Cloudflare Access answers. They go to the probed
     * origin only, never over plain `http:`.
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

/**
 * What the probe does with the Access service token for one request. `insecure`
 * is a token that is set but not sent, because the URL is not `https:`.
 */
type AccessState =
    | { headers: Record<string, string>; kind: "sent" }
    | { kind: "insecure" }
    | { kind: "invalid"; variable: string }
    | { kind: "none" }
    | { kind: "partial"; missing: string };

/** A service-token id or secret is visible ASCII; anything else (a pasted line break) would make `Headers` throw with the value in its message. */
const isHeaderToken = (value: string): boolean =>
    value !== "" && Array.from({ length: value.length }, (_, index) => value.codePointAt(index) ?? 0).every((code) => code > 0x20 && code < 0x7f);

const accessState = (env: Readonly<Record<string, string | undefined>>): AccessState => {
    const clientId = env[ACCESS_CLIENT_ID_ENV] ?? "";
    const clientSecret = env[ACCESS_CLIENT_SECRET_ENV] ?? "";

    if (clientId === "" && clientSecret === "") {
        return { kind: "none" };
    }

    if (clientId === "" || clientSecret === "") {
        return { kind: "partial", missing: clientId === "" ? ACCESS_CLIENT_ID_ENV : ACCESS_CLIENT_SECRET_ENV };
    }

    const invalid = [
        [ACCESS_CLIENT_ID_ENV, clientId],
        [ACCESS_CLIENT_SECRET_ENV, clientSecret],
    ].find(([, value]) => !isHeaderToken(value ?? ""));

    if (invalid !== undefined) {
        return { kind: "invalid", variable: String(invalid[0]) };
    }

    return { headers: { "CF-Access-Client-Id": clientId, "CF-Access-Client-Secret": clientSecret }, kind: "sent" };
};

/** The state for a request to `url`: a token is never sent over plain `http:`, where anyone on the path could read it. */
const accessFor = (state: AccessState, url: string): AccessState => (state.kind === "sent" && !url.startsWith("https:") ? { kind: "insecure" } : state);

const headersOf = (state: AccessState): Record<string, string> => (state.kind === "sent" ? state.headers : {});

/** How the deployment answered, decided once so each message is a lookup rather than a branch of its own. */
type Outcome =
    | { kind: "access-login" }
    | { kind: "denied" }
    | { kind: "https-upgrade"; location: string }
    | { kind: "not-found" }
    | { kind: "ok" }
    | { kind: "other" }
    | { kind: "redirect"; location: string };

const classify = (url: string, response: HealthResponse): Outcome => {
    if (response.ok) {
        return { kind: "ok" };
    }

    if (response.status === 404) {
        return { kind: "not-found" };
    }

    // Access answers a service token it rejects with 403 rather than a login redirect.
    if (response.status === 401 || response.status === 403) {
        return { kind: "denied" };
    }

    if (response.status < 300 || response.status >= 400) {
        return { kind: "other" };
    }

    const location = response.headers.get("location") ?? "";
    let target: URL | undefined;

    try {
        target = new URL(location, url);
    } catch {
        return { kind: "redirect", location };
    }

    if (target.hostname.endsWith(".cloudflareaccess.com") || target.pathname.startsWith("/cdn-cgi/access/")) {
        return { kind: "access-login" };
    }

    // "Always Use HTTPS" answers an `http:` probe with the same URL over `https:`. Anything else (another host, or the same
    // host's `/`, whose 200 would read as healthy) is not the health route answering.
    const source = new URL(url);

    return source.protocol === "http:" &&
        target.protocol === "https:" &&
        target.hostname === source.hostname &&
        target.pathname === source.pathname &&
        target.search === source.search
        ? { kind: "https-upgrade", location: target.href }
        : { kind: "redirect", location };
};

const BOTH = `${ACCESS_CLIENT_ID_ENV} and ${ACCESS_CLIENT_SECRET_ENV}`;

/** What to say when Access sent the probe to its login, by what the probe did with the token. */
const accessLoginMessage = (state: AccessState, url: string): string => {
    const behindAccess = "the host is behind Cloudflare Access, which redirected the probe to its login.";
    const allowed = "a service token the Access application allows (a Service Auth policy)";

    switch (state.kind) {
        case "insecure": {
            return `${behindAccess} ${BOTH} are set, but the service token is sent only over https and ${url} is http; probe the https:// URL.`;
        }
        case "partial": {
            return `${behindAccess} Only one of ${BOTH} is set; set ${state.missing} too, to ${allowed}, and the probe sends both.`;
        }
        case "sent": {
            return `Cloudflare Access refused the service token in ${BOTH} and redirected to its login. Check that the Access application has a Service Auth policy that includes this token.`;
        }
        default: {
            return `${behindAccess} Set ${BOTH} to ${allowed}, and the probe sends them.`;
        }
    }
};

interface ProbeRequest {
    /** The `http:` URL whose same-host `https:` redirect this request follows. */
    from?: string;
    url: string;
}

/** The verdict on a non-2xx answer, looked up by how the deployment answered and what the probe did with the token. */
const failureMessage = (request: ProbeRequest, response: HealthResponse, outcome: Outcome, access: AccessState): string => {
    const redirected = request.from === undefined ? "" : ` (redirected from ${request.from})`;
    const status = `health probe failed: ${request.url}${redirected} returned HTTP ${String(response.status)}`;

    switch (outcome.kind) {
        case "access-login": {
            return `${status}: ${accessLoginMessage(access, request.url)}`;
        }
        case "denied": {
            if (access.kind === "sent") {
                return `${status} with the Cloudflare Access service token from ${BOTH} sent — if the host is behind Access, check that the token is current and a Service Auth policy includes it.`;
            }

            return access.kind === "insecure" ? `${status}; the Cloudflare Access service token was not sent, because ${request.url} is not https.` : status;
        }
        // A second upgrade after the one followed is a loop, not a hop.
        case "https-upgrade":
        case "redirect": {
            return `${status}${outcome.location === "" ? "" : ` redirecting to ${outcome.location}`} — the health route does not redirect, so something in front of the Worker answered.`;
        }
        default: {
            return status;
        }
    }
};

interface Answer {
    error?: string;
    outcome?: Outcome;
    url: string;
}

const send = async (request: ProbeRequest, fetchImpl: HealthFetch, state: AccessState): Promise<Answer> => {
    const access = accessFor(state, request.url);

    try {
        const response = await fetchImpl(request.url, { headers: headersOf(access), redirect: "manual" });
        const outcome = classify(request.url, response);

        return outcome.kind === "ok" ? { outcome, url: request.url } : { error: failureMessage(request, response, outcome, access), outcome, url: request.url };
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);

        return { error: `health probe failed: could not reach ${request.url} (${message})`, url: request.url };
    }
};

/**
 * Ask one URL. A redirect to the same URL over `https:` ("Always Use HTTPS") is
 * followed once, by hand: fetch's own redirect handling would forward the
 * Access headers to wherever a redirect points, and an Access login page that
 * answers 200 would read as a healthy deployment. The token is first sent on
 * that `https:` hop, to the host the probe was pointed at.
 */
const ask = async (url: string, fetchImpl: HealthFetch, state: AccessState): Promise<Answer> => {
    const first = await send({ url }, fetchImpl, state);

    return first.outcome?.kind === "https-upgrade" ? send({ from: url, url: first.outcome.location }, fetchImpl, state) : first;
};

/** Try each path once, in order. A 404 falls through to the next path; anything else is the verdict. */
const probeOnce = async (baseUrl: string, paths: ReadonlyArray<string>, fetchImpl: HealthFetch, state: AccessState): Promise<HealthProbeResult> => {
    let last: HealthProbeResult = { error: `health probe failed: no health path configured for ${baseUrl}`, url: baseUrl };

    for (const [index, path] of paths.entries()) {
        // eslint-disable-next-line no-await-in-loop -- sequential fallback: the next path is only tried when this one 404s
        const { error, outcome, url } = await ask(joinHealthUrl(baseUrl, path), fetchImpl, state);

        last = error === undefined ? { url } : { error, url };

        // A 404 means this deployment doesn't mount that route (an older
        // runtime has no readiness gate) — fall through to the next path.
        if (outcome?.kind !== "not-found" || index === paths.length - 1) {
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
    const state = accessState(env);

    // A value no header can carry is refused before any request: the error a request would raise quotes the value.
    if (state.kind === "invalid") {
        return {
            error: `health probe not sent: ${state.variable} contains a character an HTTP header cannot carry (a line break or a space?). Set it to the service token's value alone.`,
            url: joinHealthUrl(baseUrl, paths[0]),
        };
    }

    // Node's `fetch` never times out on its own: a worker that accepts the
    // connection and then goes quiet would hang the probe — and with it
    // `deploy --health-check` — until CI's job timeout killed it. That defeats
    // the whole point of a fixed attempt budget, so bound every attempt. An
    // abort surfaces as a transport error, which `ask` already reds.
    const doFetch: HealthFetch = fetchImpl ?? (async (url, init) => fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) }));
    const budget = Math.max(1, attempts);
    let result = await probeOnce(baseUrl, paths, doFetch, state);

    for (let attempt = 1; attempt < budget && result.error !== undefined; attempt += 1) {
        // eslint-disable-next-line no-await-in-loop -- a retry is sequential by definition
        await sleep(delayMs);
        // eslint-disable-next-line no-await-in-loop -- same
        result = await probeOnce(baseUrl, paths, doFetch, state);
    }

    return result;
};

export type { HealthFetch };
export { HEALTH_PATH, HEALTH_READY_PATH, joinHealthUrl, probeHealth };

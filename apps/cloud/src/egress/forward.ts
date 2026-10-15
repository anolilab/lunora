import type { EgressPolicy } from "./policy";

/**
 * Outbound enforcement (plan 477 §4.3–4.4), composed into the Outbound Worker
 * after lineage stamping. Pure: the upstream `fetch` is injected, so the rules
 * are testable without a network.
 *
 * - `undefined` or `off`/`report` policy: the request goes out unchanged.
 * - `enforce`: a request to a listed origin goes out with `redirect: "manual"`;
 *   each `Location` is checked before it is followed, up to
 *   {@link MAX_EGRESS_REDIRECTS} hops. A denied origin never reaches the network
 *   and gets the 403 body from the plan.
 *
 * The body is streamed to the first hop and never buffered. A stream can be
 * sent once, so a redirect that must resend a body (307/308, or a 301/302 that
 * keeps a non-POST method) is not replayed: its Location is checked and the 3xx
 * is returned to the tenant, which may follow it itself.
 */

/** Followed redirects per request (plan 477 §4.4). */
export const MAX_EGRESS_REDIRECTS = 5;

export type FetchLike = (request: Request) => Promise<Response>;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a request body, removed when a redirect turns the method into GET. */
const BODY_HEADERS: ReadonlyArray<string> = ["content-encoding", "content-language", "content-length", "content-location", "content-type"];

/** The 403 body a denied origin receives (plan 477 §3). */
export const egressDenied = (origin: string): Response => Response.json({ error: "egress_denied", origin }, { status: 403 });

/** Refused when the walk would exceed the hop cap. */
const redirectLimit = (): Response => Response.json({ error: "egress_redirect_limit", max: MAX_EGRESS_REDIRECTS }, { status: 502 });

const originOf = (url: string): string => new URL(url).origin;

/** The `Location` target of a redirect, resolved against the URL it came from, or `undefined` when it is not a redirect we can follow. */
const nextLocation = (response: Response, from: string): string | undefined => {
    if (!REDIRECT_STATUSES.has(response.status)) {
        return undefined;
    }

    const location = response.headers.get("location");

    if (location === null) {
        return undefined;
    }

    try {
        return new URL(location, from).href;
    } catch {
        return undefined;
    }
};

/**
 * The 403 for a redirect target outside the allowed origins, or `undefined` when there is no target
 * or it is allowed. Every redirect target is checked through here, so the rule exists once.
 */
const deniedTarget = (target: string | undefined, allowed: ReadonlySet<string>): Response | undefined => {
    if (target === undefined) {
        return undefined;
    }

    const origin = originOf(target);

    return allowed.has(origin) ? undefined : egressDenied(origin);
};

/** One request in a redirect walk. `followed` counts the redirects already taken to reach it. */
interface Hop {
    /** Streamed, so only the first hop can carry it: see the module comment. */
    body: ReadableStream<Uint8Array> | null;
    followed: number;
    headers: Headers;
    method: string;
    url: string;
}

/**
 * The method a redirect leaves the next hop with, per the fetch spec: a 303
 * becomes GET unless the method is GET or HEAD (so HEAD stays HEAD); a 301 or
 * 302 becomes GET only for POST; 307, 308, and 301/302 on any other method keep
 * the method.
 */
const methodAfter = (method: string, status: number): string => {
    if (status === 303) {
        return method === "GET" || method === "HEAD" ? method : "GET";
    }

    if ((status === 301 || status === 302) && method === "POST") {
        return "GET";
    }

    return method;
};

/**
 * The hop after a redirect. The body is always gone: a hop that kept a body was
 * returned to the tenant instead (see `walk`). Credentials are dropped when the
 * redirect crosses origins.
 */
const nextHop = (hop: Hop, method: string, target: string): Hop => {
    const headers = new Headers(hop.headers);

    // A method change drops the body, so the headers that describe it go too. The fetch spec
    // names four of them (Content-Encoding, Content-Language, Content-Location, Content-Type).
    // Content-Length is removed as well, because it would claim a body the GET no longer sends.
    if (method !== hop.method) {
        for (const name of BODY_HEADERS) {
            headers.delete(name);
        }
    }

    if (originOf(target) !== originOf(hop.url)) {
        headers.delete("authorization");
        headers.delete("cookie");
    }

    return { body: null, followed: hop.followed + 1, headers, method, url: target };
};

/** Fetch one hop; if it redirects, check the target origin before following it. */
const walk = async (hop: Hop, allowed: ReadonlySet<string>, fetchImpl: FetchLike): Promise<Response> => {
    // `duplex` is required by Node's fetch for a streamed body and ignored by Workers.
    const init: RequestInit & { duplex?: "half" } = { body: hop.body, duplex: "half", headers: hop.headers, method: hop.method, redirect: "manual" };
    const response = await fetchImpl(new Request(hop.url, init));
    const target = nextLocation(response, hop.url);
    const denied = deniedTarget(target, allowed);

    if (denied !== undefined) {
        return denied;
    }

    if (target === undefined) {
        return response;
    }

    const method = methodAfter(hop.method, response.status);

    // A streamed body that the next hop would resend cannot be replayed. The
    // Location is already checked, so the tenant gets the 3xx instead.
    if (hop.body !== null && method === hop.method) {
        return response;
    }

    if (hop.followed === MAX_EGRESS_REDIRECTS) {
        return redirectLimit();
    }

    return walk(nextHop(hop, method, target), allowed, fetchImpl);
};

export const forwardWithEgress = async (request: Request, policy: EgressPolicy | undefined, fetchImpl: FetchLike): Promise<Response> => {
    if (policy?.mode !== "enforce") {
        return fetchImpl(request);
    }

    const allowed = new Set(policy.origins);
    const first = originOf(request.url);

    if (!allowed.has(first)) {
        return egressDenied(first);
    }

    // The tenant asked to see redirects itself, or to fail on them. Check where a 3xx points
    // before it is returned, so it cannot be used to reach a denied host.
    if (request.redirect !== "follow") {
        const response = await fetchImpl(request);

        return deniedTarget(nextLocation(response, request.url), allowed) ?? response;
    }

    // Walk the redirects ourselves. The body is streamed, not buffered, and each
    // hop is an explicit manual fetch.
    return walk({ body: request.body, followed: 0, headers: new Headers(request.headers), method: request.method, url: request.url }, allowed, fetchImpl);
};

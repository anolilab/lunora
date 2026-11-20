import type { EgressPolicy } from "./policy";

/**
 * Outbound enforcement (plan 477 §4.3–4.4), composed into the Outbound Worker
 * after lineage stamping. Pure: the upstream `fetch` is injected, so the rules
 * are testable without a network.
 *
 * - `undefined` or `off`/`report` policy: any origin is reached.
 * - `enforce`: only a listed origin is reached; each `Location` is checked
 *   before it is followed, up to {@link MAX_EGRESS_REDIRECTS} hops. A denied
 *   origin never reaches the network and gets the 403 body from the plan.
 *
 * Either way a followed redirect is walked here with `redirect: "manual"`, never
 * by `fetch`, so `prepare` runs on every hop: the lineage header is signed for
 * the host it is sent to, and one stamped for the first host would be refused
 * by the dispatcher on the next.
 *
 * Under `enforce` the body is streamed to the first hop and never buffered. A
 * stream can be sent once, so a redirect that must resend a body (307/308, or a
 * 301/302 that keeps a non-POST method) is not replayed: its Location is checked
 * and the 3xx is returned to the tenant, which may follow it itself. Without a
 * policy the walk only replaces `fetch`'s own redirect handling, so a body of up
 * to {@link MAX_REPLAY_BYTES} is held to be resent, as `fetch` would; a larger
 * one streams and gets the 3xx back.
 */

/** Followed redirects per request under an enforcing policy (plan 477 §4.4). */
export const MAX_EGRESS_REDIRECTS = 5;

/** Followed redirects without a policy: the fetch spec's own limit, so walking them here changes nothing. */
const MAX_UNPOLICED_REDIRECTS = 20;

/** The largest body held in memory to resend after a redirect, without a policy. */
export const MAX_REPLAY_BYTES = 1024 * 1024;

export type FetchLike = (request: Request) => Promise<Response>;

const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);

/** Headers that describe a request body, removed when a redirect turns the method into GET. */
const BODY_HEADERS: ReadonlyArray<string> = ["content-encoding", "content-language", "content-length", "content-location", "content-type"];

/** The 403 body a denied origin receives (plan 477 §3). */
export const egressDenied = (origin: string): Response => Response.json({ error: "egress_denied", origin }, { status: 403 });

/** Refused when the walk would exceed the hop cap. */
const redirectLimit = (max: number): Response => Response.json({ error: "egress_redirect_limit", max }, { status: 502 });

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
const deniedTarget = (target: string | undefined, allowed: ReadonlySet<string> | undefined): Response | undefined => {
    if (target === undefined || allowed === undefined) {
        return undefined;
    }

    const origin = originOf(target);

    return allowed.has(origin) ? undefined : egressDenied(origin);
};

/** Rewrites each hop's request before it is sent (the Outbound Worker stamps lineage here). */
export type PrepareHop = (request: Request) => Promise<Request>;

/** What a walk enforces: `allowed` is `undefined` when any origin may be reached. */
interface WalkRules {
    allowed: ReadonlySet<string> | undefined;
    fetchImpl: FetchLike;
    maxRedirects: number;
    prepare: PrepareHop;
}

/** One request in a redirect walk. `followed` counts the redirects already taken to reach it. */
interface Hop {
    /** Bytes are resent after a redirect; a stream reaches only the first hop. See the module comment. */
    body: ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer> | null;

    /**
     * The tenant's Cloudflare fetch options (`cacheTtl`, `cacheEverything`, …). A hop is
     * rebuilt from its URL, which on Workers starts with no `cf`, so each hop is given it again.
     */
    cf: RequestInit["cf"];
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
 * The hop after a redirect. The body goes with a method change; otherwise it is
 * held bytes, since a stream that would have to be resent was returned to the
 * tenant instead (see `walk`). Credentials are dropped when the redirect crosses
 * origins.
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

    return { body: method === hop.method ? hop.body : null, cf: hop.cf, followed: hop.followed + 1, headers, method, url: target };
};

/** Fetch one hop; if it redirects, check the target origin before following it. */
const walk = async (hop: Hop, rules: WalkRules): Promise<Response> => {
    // `duplex` is required by Node's fetch for a streamed body and ignored by Workers.
    const init: RequestInit & { duplex?: "half" } = {
        body: hop.body,
        duplex: "half",
        headers: hop.headers,
        method: hop.method,
        redirect: "manual",
        ...(hop.cf === undefined ? {} : { cf: hop.cf }),
    };
    const response = await rules.fetchImpl(await rules.prepare(new Request(hop.url, init)));
    const target = nextLocation(response, hop.url);
    const denied = deniedTarget(target, rules.allowed);

    if (denied !== undefined) {
        return denied;
    }

    if (target === undefined) {
        return response;
    }

    const method = methodAfter(hop.method, response.status);

    // A streamed body that the next hop would resend cannot be replayed. The
    // Location is already checked, so the tenant gets the 3xx instead.
    if (hop.body instanceof ReadableStream && method === hop.method) {
        return response;
    }

    if (hop.followed === rules.maxRedirects) {
        return redirectLimit(rules.maxRedirects);
    }

    return walk(nextHop(hop, method, target), rules);
};

const unchanged: PrepareHop = (request) => Promise.resolve(request);

/**
 * The tenant's `cf` options as they may be sent. `resolveOverride` sends a request to another
 * hostname than its URL's, so under an enforcing policy it would reach a host the allowlist never
 * checked; it is dropped there. Every other option shapes caching or the response, not the
 * destination, and is kept. Without an allowlist there is nothing to step around.
 */
export const outboundCf = (cf: RequestInit["cf"], enforcing: boolean): RequestInit["cf"] => {
    if (!enforcing || cf === undefined || !("resolveOverride" in cf)) {
        return cf;
    }

    const withoutOverride = ({ resolveOverride: _resolveOverride, ...rest }: typeof cf): Omit<typeof cf, "resolveOverride"> => rest;

    return withoutOverride(cf);
};

/**
 * Read a body into memory if it ends within `limit` bytes; otherwise a stream
 * that yields what was read and then the rest, so nothing is lost and no more
 * than `limit` is ever held.
 */
const holdUpTo = async (stream: ReadableStream<Uint8Array>, limit: number): Promise<ReadableStream<Uint8Array> | Uint8Array<ArrayBuffer>> => {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a stream is read one chunk after another
        const { done, value } = await reader.read();

        if (done) {
            const bytes = new Uint8Array(size);
            let offset = 0;

            for (const chunk of chunks) {
                bytes.set(chunk, offset);
                offset += chunk.byteLength;
            }

            return bytes;
        }

        chunks.push(value);
        size += value.byteLength;

        if (size > limit) {
            return new ReadableStream<Uint8Array>({
                cancel: (reason) => reader.cancel(reason),
                pull: async (controller) => {
                    const next = await reader.read();

                    if (next.done) {
                        controller.close();
                    } else {
                        controller.enqueue(next.value);
                    }
                },
                start: (controller) => {
                    for (const chunk of chunks) {
                        controller.enqueue(chunk);
                    }
                },
            });
        }
    }
};

export const forwardWithEgress = async (
    request: Request,
    policy: EgressPolicy | undefined,
    fetchImpl: FetchLike,
    prepare: PrepareHop = unchanged,
): Promise<Response> => {
    const enforcing = policy?.mode === "enforce";
    const allowed = enforcing ? new Set(policy.origins) : undefined;
    const first = originOf(request.url);

    // Refused before `prepare`, so a denied request is never stamped.
    if (allowed !== undefined && !allowed.has(first)) {
        return egressDenied(first);
    }

    const tenantCf = (request as { cf?: RequestInit["cf"] }).cf;
    const cf = outboundCf(tenantCf, enforcing);

    // The tenant asked to see redirects itself, or to fail on them. Check where a 3xx points
    // before it is returned, so it cannot be used to reach a denied host.
    if (request.redirect !== "follow") {
        const response = await fetchImpl(await prepare(cf === tenantCf ? request : new Request(request, { cf })));

        return deniedTarget(nextLocation(response, request.url), allowed) ?? response;
    }

    // Walk the redirects ourselves, each hop an explicit manual fetch.
    const body = request.body === null || enforcing ? request.body : await holdUpTo(request.body, MAX_REPLAY_BYTES);

    return walk(
        {
            body,
            cf,
            followed: 0,
            headers: new Headers(request.headers),
            method: request.method,
            url: request.url,
        },
        { allowed, fetchImpl, maxRedirects: enforcing ? MAX_EGRESS_REDIRECTS : MAX_UNPOLICED_REDIRECTS, prepare },
    );
};

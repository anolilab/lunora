/** Tab, CR and LF — removed from anywhere in the input by WHATWG URL parsing. */
const REMOVED_ANYWHERE = new Set(["\t", "\n", "\r"]);

/** The C0-and-space range WHATWG URL parsing trims from both ends. */
const TRIMMED_MAX = "\u0020";

/**
 * Reduce `path` to what `fetch` will actually parse.
 *
 * WHATWG URL parsing strips leading and trailing C0-and-space and removes every
 * ASCII tab, CR and LF from ANYWHERE in the input — so `" https://host/x"` and
 * `"htt\tps://host/x"` both reach the network as `https://host/x`. Testing the
 * raw string would let either walk straight past {@link NAMES_ITS_OWN_HOST} with
 * the admin bearer attached. Normalize first, then both test AND fetch the
 * normalized form, so the string that was checked is the string that is sent.
 *
 * Written with explicit scans rather than a regex: the trims need the full
 * `\u0000`-`\u0020` range (`String.trim` stops short of the C0 controls, which
 * would leave `"\u0001https://host/x"` a hole), and a character-class quantifier
 * over that range is what `sonarjs/slow-regex` refuses.
 */
const normalizeForFetch = (path: string): string => {
    let collapsed = "";

    for (const character of path) {
        if (!REMOVED_ANYWHERE.has(character)) {
            collapsed += character;
        }
    }

    let first = 0;
    let last = collapsed.length;

    while (first < last && (collapsed[first] ?? "") <= TRIMMED_MAX) {
        first += 1;
    }

    while (last > first && (collapsed[last - 1] ?? "") <= TRIMMED_MAX) {
        last -= 1;
    }

    return collapsed.slice(first, last);
};

/** `https://host/x` or the protocol-relative `//host/x` — a path that names its own host. */
const NAMES_ITS_OWN_HOST = /^(?:[a-z][\d+.a-z-]*:)?\/\//i;

/**
 * Resolve `httpPath` against the console's origin, refusing a result that lands
 * on a different one. `httpPath` is normally a relative path, but an absolute
 * URL in the OpenAPI document would make `new URL` ignore the base and send the
 * request — carrying the admin bearer — to whatever host it names. The document
 * is the developer's own, so this is a backstop rather than a trust boundary,
 * but the bearer is the reason to keep it.
 *
 * An empty `origin` means "same origin as the console", which is
 * `location.origin` — NOT "no base, send it as written". Reading it as the
 * latter is what let an absolute `httpPath` skip this check entirely.
 */
const resolveTarget = (httpPath: string, origin: string): string => {
    // The DOM lib types `location` as always present, but this module is also
    // exercised outside a browser, where it is not — hence the widened read
    // rather than an optional chain the type checker calls redundant.
    const consoleOrigin = (globalThis as { location?: { origin?: string } }).location?.origin ?? "";
    const base = origin === "" ? consoleOrigin : origin;
    const target = normalizeForFetch(httpPath);

    if (base === "") {
        // No `location` to resolve against (outside a browser). A relative path
        // is safe as written; one that names its own host cannot be checked, so
        // it is refused rather than sent with the bearer attached.
        if (NAMES_ITS_OWN_HOST.test(target)) {
            throw new Error(
                `restDispatch: refusing to send the admin token off-origin (${target} names its own host and there is no origin to check it against)`,
            );
        }

        return target;
    }

    const resolved = new URL(target, base);

    if (resolved.origin !== new URL(base).origin) {
        throw new Error(`restDispatch: refusing to send the admin token off-origin (${resolved.origin} is not ${base})`);
    }

    return resolved.toString();
};

/**
 * Dispatch a plain REST route (an `httpRouter()` operation, no `functionPath`)
 * to the worker origin with the admin bearer, and parse the response body.
 *
 * A same-origin fetch would be answered by the studio's own server — under
 * `lunora dev` the SPA fallback returns the studio document as a 200 for any
 * non-`/_lunora/*` path, so "Send" rendered the studio's own HTML as a
 * successful response — so the request must target the worker explicitly. The
 * REST counterpart to `dispatchByKind`, which carries the RPC half of the
 * try-it console. When `origin` is empty the path is resolved against the
 * console's own origin, which is still checked — see {@link resolveTarget}.
 *
 * `operation` is typed structurally (rather than as the API feature's
 * `ApiOperation`) so this stays a `lib` module with no dependency on a feature.
 */
const restDispatch = async (operation: { httpPath: string; method: string }, args: unknown, origin: string, adminToken: null | string): Promise<unknown> => {
    const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
    const url = resolveTarget(operation.httpPath, origin);

    const fetchResponse = await fetch(url, {
        body: hasBody ? JSON.stringify(args) : undefined,
        headers: {
            ...(hasBody ? { "content-type": "application/json" } : {}),
            ...(adminToken === null || adminToken === "" ? {} : { authorization: `Bearer ${adminToken}` }),
        },
        method: operation.method,
    });

    // Read the body once, then parse — a Response stream can't be read twice,
    // so `.json().catch(() => .text())` would throw on a non-JSON body.
    const text = await fetchResponse.text();

    try {
        return JSON.parse(text) as unknown;
    } catch {
        return text;
    }
};

export default restDispatch;

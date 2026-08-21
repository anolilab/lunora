/**
 * Dispatch a plain REST route (an `httpRouter()` operation, no `functionPath`)
 * to the worker origin with the admin bearer, and parse the response body.
 *
 * A same-origin fetch would be answered by the studio's own server — under
 * `lunora dev` the SPA fallback returns the studio document as a 200 for any
 * non-`/_lunora/*` path, so "Send" rendered the studio's own HTML as a
 * successful response — so the request must target the worker explicitly. The
 * REST counterpart to `dispatchByKind`, which carries the RPC half of the
 * try-it console. When `origin` is empty the path is fetched same-origin.
 *
 * `operation` is typed structurally (rather than as the API feature's
 * `ApiOperation`) so this stays a `lib` module with no dependency on a feature.
 */
const restDispatch = async (operation: { httpPath: string; method: string }, args: unknown, origin: string, adminToken: null | string): Promise<unknown> => {
    const hasBody = operation.method !== "GET" && operation.method !== "HEAD";
    const url = origin === "" ? operation.httpPath : new URL(operation.httpPath, origin).toString();

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

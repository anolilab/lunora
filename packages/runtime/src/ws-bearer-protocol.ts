/**
 * A browser cannot set `Authorization` on a WebSocket upgrade, and a session
 * credential must never ride the URL (every proxy logs it). The one header a
 * browser *can* set on the handshake is `Sec-WebSocket-Protocol`, so a client
 * holding a bearer (an external IdP's JWT — Clerk, WorkOS, …) offers it as a
 * subprotocol:
 *
 * ```
 * Sec-WebSocket-Protocol: lunora, lunora.bearer.<base64url(token)>
 * ```
 *
 * The worker lifts it into `Authorization` for `resolveIdentity` only, so every
 * resolver (and `memoizeIdentity`'s Cookie/Authorization cache key) sees it
 * exactly like a header bearer; strips it before forwarding to the shard; and
 * answers the handshake selecting `lunora`, which the browser requires once it
 * offered any subprotocol. The bearer authenticates the USER only — it never
 * reaches the shard's `LUNORA_WS_BEARER` / admin checks, which read the
 * forwarded request's own `Authorization` and `connect` frame.
 */

import { fromBase64Url } from "../../../shared/base64";

/** The subprotocol a Lunora client offers and the worker selects. */
const LUNORA_WS_PROTOCOL = "lunora";

/** Prefix of the subprotocol entry carrying the base64url-encoded bearer. */
const BEARER_PROTOCOL_PREFIX = "lunora.bearer.";

const offeredProtocols = (request: Request): string[] =>
    (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

/** The bearer offered as a `lunora.bearer.*` subprotocol, decoded, or `undefined`. */
const subprotocolBearer = (request: Request): string | undefined => {
    const entry = offeredProtocols(request).find((protocol) => protocol.startsWith(BEARER_PROTOCOL_PREFIX));

    if (entry === undefined) {
        return undefined;
    }

    try {
        const token = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(entry.slice(BEARER_PROTOCOL_PREFIX.length)));

        return token.length > 0 ? token : undefined;
    } catch {
        return undefined;
    }
};

/**
 * The request `resolveIdentity` should see for an upgrade: the original when it
 * already carries `Authorization` (a native client's header wins) or offers no
 * bearer subprotocol, else a clone with the subprotocol bearer as
 * `Authorization: Bearer`.
 */
const identityRequestForUpgrade = (request: Request): Request => {
    if (request.headers.has("authorization")) {
        return request;
    }

    const token = subprotocolBearer(request);

    if (token === undefined) {
        return request;
    }

    const headers = new Headers(request.headers);

    headers.set("authorization", `Bearer ${token}`);

    return new Request(request, { headers });
};

/** Whether the client offered the `lunora` subprotocol, which the handshake must then select. */
const offersLunoraProtocol = (request: Request): boolean => offeredProtocols(request).includes(LUNORA_WS_PROTOCOL);

/** Drop the bearer from the headers forwarded to the shard, keeping only the `lunora` offer. */
const stripBearerProtocol = (request: Request, headers: Headers): void => {
    if (!request.headers.has("sec-websocket-protocol")) {
        return;
    }

    if (offersLunoraProtocol(request)) {
        headers.set("sec-websocket-protocol", LUNORA_WS_PROTOCOL);
    } else {
        headers.delete("sec-websocket-protocol");
    }
};

/**
 * Select `lunora` on the shard's `101` when the client offered it. A browser
 * that offered subprotocols fails the handshake if the response names none.
 * Only a Cloudflare-shaped upgrade (a `101` carrying `webSocket`) is rewritten;
 * the Node host completes its handshake with `ws`, which selects the first
 * offered protocol (`lunora`) itself.
 */
const selectLunoraProtocol = (request: Request, response: Response): Response => {
    const { webSocket } = response as Response & { webSocket?: unknown };

    if (response.status !== 101 || !webSocket || !offersLunoraProtocol(request)) {
        return response;
    }

    const headers = new Headers(response.headers);

    headers.set("sec-websocket-protocol", LUNORA_WS_PROTOCOL);

    // eslint-disable-next-line unicorn/no-null -- a 101 switching-protocols response has no body
    return new Response(null, { headers, status: 101, webSocket });
};

export { identityRequestForUpgrade, selectLunoraProtocol, stripBearerProtocol, subprotocolBearer };

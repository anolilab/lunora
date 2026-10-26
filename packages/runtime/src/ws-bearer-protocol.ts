/**
 * The worker side of the bearer-on-upgrade contract in
 * `shared/ws-bearer-protocol.ts`. The worker lifts the offered bearer into
 * `Authorization` for `resolveIdentity` only, so every resolver (and
 * `memoizeIdentity`'s Cookie/Authorization cache key) sees it exactly like a
 * header bearer; strips it before forwarding to the shard; and answers the
 * handshake selecting `lunora`. The bearer authenticates the USER only — it
 * never reaches the shard's `LUNORA_WS_BEARER` / admin checks, which read the
 * forwarded request's own `Authorization` and `connect` frame.
 */

import { BEARER_PROTOCOL_PREFIX, decodeBearerProtocol, LUNORA_WS_PROTOCOL } from "../../../shared/ws-bearer-protocol";

/** What an upgrade offered in `Sec-WebSocket-Protocol`, parsed once per upgrade. */
interface BearerUpgrade {
    /** The offered subprotocols other than the bearer entry, which is the only one the shard must not see. */
    forwarded: string[];

    /** The decoded `lunora.bearer.*` token, or `undefined`. */
    token: string | undefined;
}

const bearerUpgrade = (request: Request): BearerUpgrade => {
    const offered = (request.headers.get("sec-websocket-protocol") ?? "")
        .split(",")
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);
    let token: string | undefined;

    for (const entry of offered) {
        token ??= decodeBearerProtocol(entry);
    }

    return { forwarded: offered.filter((entry) => !entry.startsWith(BEARER_PROTOCOL_PREFIX)), token };
};

/**
 * The request `resolveIdentity` should see for an upgrade: the original when it
 * already carries `Authorization` (a native client's header wins) or offers no
 * bearer, else a clone with the bearer as `Authorization: Bearer`.
 */
const identityRequestForUpgrade = (request: Request, upgrade: BearerUpgrade): Request => {
    if (upgrade.token === undefined || request.headers.has("authorization")) {
        return request;
    }

    const headers = new Headers(request.headers);

    headers.set("authorization", `Bearer ${upgrade.token}`);

    return new Request(request, { headers });
};

/** `headers` without the bearer entry; every other offered subprotocol is forwarded as it came. */
const withoutBearerProtocol = (headers: Headers, upgrade: BearerUpgrade): Headers => {
    const stripped = new Headers(headers);

    if (upgrade.forwarded.length > 0) {
        stripped.set("sec-websocket-protocol", upgrade.forwarded.join(", "));
    } else {
        stripped.delete("sec-websocket-protocol");
    }

    return stripped;
};

/**
 * Select `lunora` on the shard's `101` when the client offered it. A browser
 * that offered subprotocols fails the handshake if the response names none.
 * Only a Cloudflare-shaped upgrade (a `101` carrying `webSocket`) is rewritten;
 * the Node host completes its handshake with `ws`, which selects the first
 * offered protocol (`lunora`) itself.
 */
const selectLunoraProtocol = (upgrade: BearerUpgrade, response: Response): Response => {
    const { webSocket } = response as Response & { webSocket?: unknown };

    if (response.status !== 101 || !webSocket || !upgrade.forwarded.includes(LUNORA_WS_PROTOCOL)) {
        return response;
    }

    const headers = new Headers(response.headers);

    headers.set("sec-websocket-protocol", LUNORA_WS_PROTOCOL);

    // eslint-disable-next-line unicorn/no-null -- a 101 switching-protocols response has no body
    return new Response(null, { headers, status: 101, webSocket });
};

export type { BearerUpgrade };
export { bearerUpgrade, identityRequestForUpgrade, selectLunoraProtocol, withoutBearerProtocol };

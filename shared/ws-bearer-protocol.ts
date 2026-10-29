/**
 * The wire contract for a bearer offered on a WebSocket upgrade. A browser
 * cannot set `Authorization` on the handshake, and a session credential must
 * never ride the URL (every proxy logs it). The one header a browser can set is
 * `Sec-WebSocket-Protocol`, so a client holding a bearer (an external IdP's JWT,
 * e.g. Clerk or WorkOS) offers it as a subprotocol:
 *
 * ```
 * Sec-WebSocket-Protocol: lunora, lunora.bearer.<base64url(token)>
 * ```
 *
 * The worker lifts the bearer into `Authorization` for `resolveIdentity` and
 * answers the handshake selecting `lunora`, which a browser requires once it
 * offered any subprotocol.
 *
 * Shared by `@lunora/client` (encodes), `@lunora/react-native` (recognizes the
 * offer) and `@lunora/runtime` (decodes) so the literals cannot drift. Not a
 * package: consumers import it by relative path and the bundler inlines it, so
 * it stays zero-dependency (relative imports only).
 */
import { fromBase64Url, toBase64Url } from "./base64";

/** The subprotocol a Lunora client offers and the worker selects. */
const LUNORA_WS_PROTOCOL = "lunora";

/** Prefix of the subprotocol entry carrying the base64url-encoded bearer. */
const BEARER_PROTOCOL_PREFIX = "lunora.bearer.";

/**
 * Every JWT and opaque bearer in practice is visible ASCII. Anything else (a
 * newline, a non-Latin-1 character) would make `Headers#set("authorization", …)`
 * throw on the worker, so it is refused here.
 */
const VISIBLE_ASCII = /^[!-~]+$/u;

/** The `lunora.bearer.*` subprotocol entry carrying `token`. */
const encodeBearerProtocol = (token: string): string => `${BEARER_PROTOCOL_PREFIX}${toBase64Url(new TextEncoder().encode(token))}`;

/** The bearer carried by a `lunora.bearer.*` entry, or `undefined` when the entry is not one or does not decode to a visible-ASCII token. */
const decodeBearerProtocol = (entry: string): string | undefined => {
    if (!entry.startsWith(BEARER_PROTOCOL_PREFIX)) {
        return undefined;
    }

    try {
        const token = new TextDecoder("utf-8", { fatal: true }).decode(fromBase64Url(entry.slice(BEARER_PROTOCOL_PREFIX.length)));

        return VISIBLE_ASCII.test(token) ? token : undefined;
    } catch {
        return undefined;
    }
};

export { BEARER_PROTOCOL_PREFIX, decodeBearerProtocol, encodeBearerProtocol, LUNORA_WS_PROTOCOL };

/**
 * Worker route a client posts a refreshed credential to, naming one of its open
 * sockets by the `connectionId` from that socket's `identity` frame. The worker
 * verifies the credential exactly as it does an upgrade and forwards the result to
 * the shard at the same path; the shard moves the socket's expiry when the subject
 * and claims are unchanged. The socket stays open and keeps its subscriptions.
 */
export const SOCKET_REAUTH_PATH = "/_lunora/ws/reauth";

/**
 * How long an authenticated subscription socket may go without its identity being
 * re-resolved through {@link SOCKET_REAUTH_PATH}. The shard cannot run
 * `resolveIdentity`, so this is what bounds how long a revoked session or a changed
 * tenant claim keeps receiving. Matches the default cross-request identity cache
 * window, so a socket is never staler than an HTTP call may already be.
 */
export const SOCKET_REVALIDATE_MS = 60_000;

/**
 * Close code for a socket whose identity was not re-resolved in time, or was
 * re-resolved to different claims. Deliberately not `4001`: nothing about the
 * credential lapsed, so a client must reconnect (re-resolving identity on the
 * upgrade) without signalling token expiry to the app.
 */
export const IDENTITY_STALE_CLOSE_CODE = 4005;

/**
 * The close reason that tells a client the re-auth resolved the same user under different claims, as
 * opposed to a window that merely lapsed. It rides the close because the shard closes the socket before
 * it answers the re-auth request, so the answer can reach a client that has already dropped the socket.
 */
export const IDENTITY_CHANGED_CLOSE_REASON = "identity_changed";

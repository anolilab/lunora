/**
 * Worker route a client posts a refreshed credential to, naming one of its open
 * sockets by the `connectionId` from that socket's `identity` frame. The worker
 * verifies the credential exactly as it does an upgrade and forwards the result to
 * the shard at the same path; the shard moves the socket's expiry when the subject
 * and claims are unchanged. The socket stays open and keeps its subscriptions.
 */
export const SOCKET_REAUTH_PATH = "/_lunora/ws/reauth";

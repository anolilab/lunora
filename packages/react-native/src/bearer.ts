// Match the better-auth session-token cookie in a `name=value; …` string —
// handling the `__Secure-` and any app prefix. `[^;=]*` also eats the leading
// space after `; `, so there's no separate `\s*` (which would overlap it and
// risk backtracking).
const SESSION_TOKEN_COOKIE = /(?:^|;)[^;=]*session_token=([^;]+)/;

/**
 * Read the current better-auth session token from an Expo auth client, for use
 * as a **bearer** credential on the Lunora client — `client.setAuthToken(token)`
 * for HTTP RPC and `client.setWsToken(token ?? undefined)` for the live socket.
 *
 * The Expo plugin persists the session as a cookie in `SecureStore`;
 * `getCookie()` exposes it, and this pulls the `session_token` value out.
 * better-auth's `bearer` plugin accepts that value verbatim in the
 * `Authorization` header — so the native client authenticates WITHOUT sending a
 * `Cookie`, which the runtime's CSRF guard rejects on an `Origin`-less native
 * request (React Native sends no `Origin`). Returns `null` when signed out.
 *
 * Re-run it whenever the session changes and feed the result to the client (see
 * the package README):
 *
 * ```ts
 * const token = expoBearerToken(authClient);
 * client.setAuthToken(token);
 * client.setWsToken(token ?? undefined);
 * ```
 * @experimental
 */
const expoBearerToken = (authClient: { getCookie: () => string }): null | string => {
    // Its raw value passes to the `bearer` plugin, which decodes it if URL-encoded.
    const match = SESSION_TOKEN_COOKIE.exec(authClient.getCookie());

    // eslint-disable-next-line unicorn/no-null -- documented signed-out sentinel (matches client.setAuthToken's `string | null`)
    return match?.[1] ?? null;
};

export default expoBearerToken;

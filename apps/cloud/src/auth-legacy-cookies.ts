/**
 * The session cookies the control plane set before the `__Host-` rename, under the
 * `__Secure-` prefix it used over HTTPS. Browsers keep them until they expire, and
 * nothing reads them any more. The first auth request that still carries one clears
 * it, and the browser stops sending the name. A sibling tenant can plant one again
 * with a `Domain` attribute, so the clearing can repeat; that costs header bytes and
 * nothing else. Sign-out clears them too, whether or not the request carries one.
 *
 * Only the `__Secure-` names are listed. The unprefixed `better-auth.*` names were
 * only ever set on plain-HTTP development, where a local app of another project may
 * own the same cookie name, so clearing them would sign that app out.
 * The `__Host-` cookies are never cleared here; they are the live session.
 */
const LEGACY_AUTH_COOKIES = ["session_token", "session_data", "account_data", "dont_remember"].map((name) => `__Secure-better-auth.${name}`);

// Must match better-auth's sign-out route as mounted in `auth.ts`.
const SIGN_OUT_PATH = "/api/auth/sign-out";

const carriesLegacyCookie = (request: Request): boolean => {
    const pairs = (request.headers.get("cookie") ?? "").split(";").map((pair) => pair.trim());

    return LEGACY_AUTH_COOKIES.some((name) => pairs.some((pair) => pair.startsWith(`${name}=`)));
};

/**
 * Appends a clearing `Set-Cookie` for each legacy name to an auth response, when the
 * request is a sign-out or carries a legacy cookie. Any other response is returned untouched.
 */
export const clearLegacyAuthCookies = (request: Request, response: Response): Response => {
    const signingOut = request.method === "POST" && new URL(request.url).pathname === SIGN_OUT_PATH;

    if (!signingOut && !carriesLegacyCookie(request)) {
        return response;
    }

    const stamped = new Response(response.body, response);

    for (const name of LEGACY_AUTH_COOKIES) {
        stamped.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Lax`);
    }

    return stamped;
};

/**
 * Wraps the auth handler so every auth response it returns gets the legacy clearing. The control
 * plane wires its `/api/auth/*` route through this, so the wiring itself is testable.
 */
export const withLegacyCookieClearing =
    (handle: (request: Request) => Promise<Response | undefined>) =>
    async (request: Request): Promise<Response | undefined> => {
        const response = await handle(request);

        return response && clearLegacyAuthCookies(request, response);
    };

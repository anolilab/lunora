/** Default header Cloudflare Access sets on every proxied request. */
const DEFAULT_HEADER = "cf-access-jwt-assertion";
/** Default cookie Access sets on top-level browser navigations. */
const DEFAULT_COOKIE = "CF_Authorization";

/**
 * Pull the Access JWT off a request: the `Cf-Access-Jwt-Assertion` header first
 * (the assertion Cloudflare adds to every proxied request), falling back to the
 * `CF_Authorization` cookie (present on top-level browser navigations). Returns
 * `undefined` when neither is set.
 */
const readToken = (request: Request, headerName: string, cookieName: string): string | undefined => {
    const headerValue = request.headers.get(headerName);

    if (headerValue !== null && headerValue.length > 0) {
        return headerValue;
    }

    const cookieHeader = request.headers.get("cookie");

    if (cookieHeader === null) {
        return undefined;
    }

    for (const part of cookieHeader.split(";")) {
        const eq = part.indexOf("=");

        if (eq === -1) {
            continue;
        }

        if (part.slice(0, eq).trim() === cookieName) {
            const value = part.slice(eq + 1).trim();

            return value.length > 0 ? value : undefined;
        }
    }

    return undefined;
};

export { DEFAULT_COOKIE, DEFAULT_HEADER, readToken };

/**
 * Platform-wide response headers, applied to every non-101 response `fetch`
 * returns: tenant responses, the dispatcher's own gates, and the debug
 * `x-lunora-id` stamp when the tenant was served. An exception the dispatcher
 * rethrows is not a response and is not covered; the Workers runtime builds that
 * response, and it carries none of these headers.
 *
 * `nosniff` stops a browser guessing a type for a tenant response. The referrer
 * policy is a default: a tenant that sets its own keeps it, so the platform never
 * overrides a tenant choice. A 101 upgrade is returned verbatim because its headers
 * are immutable.
 *
 * This is the one place a dispatcher response is copied, so its headers can be set.
 */
export const withPlatformHeaders = (response: Response, lunoraId?: string): Response => {
    if (response.status === 101) {
        return response;
    }

    const stamped = new Response(response.body, response);

    stamped.headers.set("x-content-type-options", "nosniff");

    if (!response.headers.has("referrer-policy")) {
        stamped.headers.set("referrer-policy", "strict-origin-when-cross-origin");
    }

    if (lunoraId !== undefined) {
        stamped.headers.set("x-lunora-id", lunoraId);
    }

    return stamped;
};

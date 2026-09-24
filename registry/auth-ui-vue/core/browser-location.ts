/**
 * Reading the browser's URL, once.
 *
 * Every screen that lands on a link needs a query parameter out of it — the
 * verification token, the invitation id, the device code, the consent id — and
 * none of that is framework-specific. It was nonetheless written five times,
 * once per port, beside a sixth spelling of the same SSR guard in
 * `invitations.ts`. This is that one place.
 *
 * Both helpers return a benign value off the browser rather than throwing, so a
 * server render of an auth screen produces "no parameter" instead of a crash.
 */

/**
 * Whether there is a browser URL to read at all.
 *
 * "No parameter" and "nowhere to read a parameter from" are different answers,
 * and a controller that consumes a link's token at construction has to tell
 * them apart. Off the browser it must render the *pending* state — the same one
 * the client paints while the token is in flight — because acting on the absent
 * parameter server-side bakes the failure state into the SSR markup and React
 * throws the whole server tree away on hydration. Same reasoning as
 * `lastLoginMethodStore` in `last-login-method.ts`, one layer down.
 */
const isBrowser = (): boolean => (globalThis as { location?: unknown }).location !== undefined;

/** One query parameter from the current URL, or undefined off the browser. */
const queryParameter = (name: string): string | undefined => {
    const search = (globalThis as { location?: { search?: string } }).location?.search;

    if (search === undefined || search === "") {
        return undefined;
    }

    return new URLSearchParams(search).get(name) ?? undefined;
};

/** The current path + query, or `/` off the browser (SSR has nowhere to return to). */
const currentPath = (): string => {
    const { location } = globalThis as { location?: { pathname?: string; search?: string } };

    return location === undefined ? "/" : `${location.pathname ?? "/"}${location.search ?? ""}`;
};

export { currentPath, isBrowser, queryParameter };

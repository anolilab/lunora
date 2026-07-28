/**
 * Read one query parameter off the current URL, or undefined off the browser.
 *
 * The React port keeps this beside the two cards that use it, because they share
 * a file. Svelte is one component per file, so the three cards that pick a token
 * out of the URL — `&lt;VerifyEmailCard>`, `&lt;AcceptInvitationCard>` and
 * `&lt;DeviceAuthorizationCard>` — share it from here rather than carrying three
 * copies.
 */
const queryParameter = (name: string): string | undefined => {
    const search = (globalThis as { location?: { search?: string } }).location?.search;

    if (search === undefined || search === "") {
        return undefined;
    }

    return new URLSearchParams(search).get(name) ?? undefined;
};

export { queryParameter };

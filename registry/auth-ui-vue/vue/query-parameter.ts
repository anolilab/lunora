/**
 * Read one query parameter off the current URL, or undefined off the browser.
 *
 * The cards that land on an emailed link (`?token=`, `?invitationId=`,
 * `?user_code=`) each default a prop to it. In the React port this helper is
 * duplicated per file because those components share one module; a Vue SFC is
 * one component per file, so it lives here instead of three times over.
 */
const queryParameter = (name: string): string | undefined => {
    const search = (globalThis as { location?: { search?: string } }).location?.search;

    if (search === undefined || search === "") {
        return undefined;
    }

    return new URLSearchParams(search).get(name) ?? undefined;
};

export { queryParameter };

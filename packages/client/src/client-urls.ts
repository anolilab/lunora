/** Build the `&bucket=…` query fragment for a storage admin request, or `""` when no bucket is selected. */
const bucketQuery = (bucket?: string): string => (bucket === undefined || bucket === "" ? "" : `&bucket=${encodeURIComponent(bucket)}`);

const deriveWsUrl = (url: string): string => {
    if (url.startsWith("https://")) {
        return `wss://${url.slice("https://".length)}`;
    }

    if (url.startsWith("http://")) {
        return `ws://${url.slice("http://".length)}`;
    }

    return url;
};

const joinUrl = (base: string, path: string): string => {
    const trimmed = base.endsWith("/") ? base.slice(0, -1) : base;

    return `${trimmed}${path}`;
};

/** A path with the non-empty entries of `params` appended as a query string (omitting `?` when none apply). */
const withQuery = (path: string, params: Record<string, number | string | undefined>): string => {
    const search = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== "") {
            search.set(key, String(value));
        }
    }

    const query = search.toString();

    return query === "" ? path : `${path}?${query}`;
};

export { bucketQuery, deriveWsUrl, joinUrl, withQuery };

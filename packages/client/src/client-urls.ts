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

/** Base for a socket URL that is same-origin (relative), so it parses; the base is dropped again by {@link serializeSocketUrl}. */
// eslint-disable-next-line sonarjs/no-clear-text-protocols -- a placeholder base that is never sent; it is stripped again
const SAME_ORIGIN_BASE = "http://same-origin.invalid";

/** Parse a socket URL that may be absolute or relative to the page. */
const parseSocketUrl = (value: string): URL => new URL(value, SAME_ORIGIN_BASE);

/** The URL back in the form it was given: absolute stays absolute, protocol-relative keeps its host, a relative URL stays relative. */
const ABSOLUTE_URL = /^[a-z][a-z\d+.-]*:/iu;

const serializeSocketUrl = (url: URL, original: string): string => {
    if (ABSOLUTE_URL.test(original)) {
        return url.toString();
    }

    const path = `${url.pathname}${url.search}${url.hash}`;

    return original.startsWith("//") ? `//${url.host}${path}` : path;
};

export { bucketQuery, deriveWsUrl, joinUrl, parseSocketUrl, serializeSocketUrl, withQuery };

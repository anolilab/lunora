/**
 * What a single-page app's Worker answers for a `GET` / `HEAD` no route served.
 *
 * Such an app sends every path to the Worker first (`run_worker_first: ["/*",
 * …]`, written by `@lunora/config`), because Cloudflare otherwise answers every
 * path a narrower list misses with `index.html`, a webhook `POST` included. The
 * Worker then owns what the asset router used to do: serve a static file, and the
 * app shell for a page navigation.
 *
 * The request goes to the assets binding unchanged, so Cloudflare does the path
 * decoding and normalization; nothing here builds an asset path from the
 * request. Under `not_found_handling: "single-page-application"` the binding
 * answers a missing path with the shell and a `200`, so the shell is recognised
 * by its `ETag`, read from a fixed request for the site root.
 */

/** A Workers Static Assets binding (`env.ASSETS`), as far as the fallback uses it. */
interface AssetsFetcherLike {
    fetch: (request: Request) => Promise<Response>;
}

/** The shell's `ETag` per binding, once read. An isolate never outlives its deploy, so the assets never change under it. */
const shellETags = new WeakMap<AssetsFetcherLike, string>();

/**
 * The shell's `ETag`. Asked for at `/`, built from the request's origin alone:
 * `/index.html` answers a `307` to `/` under the default `html_handling`, and `/`
 * serves `index.html` under every one of them. No request header is forwarded,
 * so a conditional request cannot turn it into a `304` without a tag.
 */
const shellETag = async (assets: AssetsFetcherLike, request: Request): Promise<string | undefined> => {
    const known = shellETags.get(assets);

    if (known !== undefined) {
        return known;
    }

    const shell = await assets.fetch(new Request(new URL("/", request.url), { method: "HEAD" }));
    const tag = shell.ok ? (shell.headers.get("ETag") ?? undefined) : undefined;

    await shell.body?.cancel();

    if (tag !== undefined) {
        shellETags.set(assets, tag);
    }

    return tag;
};

/** A browser page load: `Sec-Fetch-Mode: navigate`, or, from a client that sends no fetch metadata, an `Accept` naming HTML. */
const isNavigation = (request: Request): boolean =>
    request.headers.get("Sec-Fetch-Mode") === "navigate" || (request.headers.get("Accept") ?? "").includes("text/html");

/**
 * The binding's answer for a request no route served, or `undefined` to keep the
 * Worker's 404: a real file (or the redirect `html_handling` gives one) as is,
 * the shell for a page navigation, and nothing for any other method, for a
 * non-navigation request the binding could only answer with the shell, or for a
 * binding error.
 */
const serveSpaAsset = async (assets: AssetsFetcherLike, request: Request): Promise<Response | undefined> => {
    if (request.method !== "GET" && request.method !== "HEAD") {
        return undefined;
    }

    const response = await assets.fetch(request);

    if (response.status >= 300 && response.status < 400 && response.status !== 304) {
        return response;
    }

    if (!response.ok && response.status !== 304) {
        await response.body?.cancel();

        return undefined;
    }

    const tag = response.headers.get("ETag");
    const isShell = tag !== null && new URL(request.url).pathname !== "/" && tag === (await shellETag(assets, request));

    if (!isShell || isNavigation(request)) {
        return response;
    }

    await response.body?.cancel();

    return undefined;
};

/** A `GET` / `HEAD` page load, which a route-less path answers with the shell. */
const isShellNavigation = (request: Request): boolean => (request.method === "GET" || request.method === "HEAD") && isNavigation(request);

export type { AssetsFetcherLike };
export { isShellNavigation, serveSpaAsset };

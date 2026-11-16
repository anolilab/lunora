/**
 * Read one of Studio's generated documents from the Workers Static Assets
 * binding codegen wires it to (see `studioAssets` in `@lunora/codegen`).
 *
 * The documents sit at `/_lunora/studio/<name>.json` in an assets directory whose
 * `run_worker_first` is `true`, so no request reaches them except through the
 * binding. The path is fixed, never taken from the request, and so is the origin:
 * the binding reads only the pathname.
 */

/** A Workers Static Assets binding, as far as this module uses it. */
interface StudioAssetsFetcher {
    fetch: (request: Request) => Promise<Response>;
}

/** The documents codegen writes as assets. */
type StudioDocumentName = "architecture" | "openapi" | "openrpc";

/** A fixed origin: the asset binding resolves the path alone. */
const STUDIO_ASSETS_ORIGIN = "https://lunora-studio.invalid";

const isFetcher = (binding: unknown): binding is StudioAssetsFetcher =>
    typeof binding === "object" && binding !== null && typeof (binding as { fetch?: unknown }).fetch === "function";

/**
 * The document, or `undefined` when the binding is missing or does not hold it
 * (the admin route then answers its empty document). Only a `2xx` JSON answer
 * counts: a binding that falls back to a single-page app answers a missing file
 * with `index.html` and a `200`.
 */
const loadStudioDocument = async (binding: unknown, name: StudioDocumentName): Promise<unknown> => {
    if (!isFetcher(binding)) {
        return undefined;
    }

    const response = await binding.fetch(new Request(`${STUDIO_ASSETS_ORIGIN}/_lunora/studio/${name}.json`));

    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) {
        await response.body?.cancel();

        return undefined;
    }

    return response.json();
};

export type { StudioDocumentName };
export { loadStudioDocument };

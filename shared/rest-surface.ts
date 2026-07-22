/**
 * The public-REST surface contract (plan 167), shared by `@lunora/runtime` (which
 * ROUTES REST requests to procedures) and `@lunora/codegen` (which DESCRIBES the
 * exposed surface in the generated OpenAPI). Kept here — inlined into each
 * consumer's bundle — so the live router and the published spec can never drift on
 * the path/method mapping without a runtime dependency edge between the packages.
 * This shared derivation is exactly what makes "the published OpenAPI matches the
 * live REST surface" a structural guarantee rather than a hand-kept invariant.
 *
 * Zero-dependency by design (see the repo's `shared/` rules): only relative/builtin
 * imports, named exports, no `.js` extensions.
 */

/** URL prefix every opt-in REST endpoint lives under. Reserved (`/_lunora/*`), so it never collides with an app's own routes. */
const REST_PATH_PREFIX = "/_lunora/rest";

/** Procedure kinds that can be exposed over REST (`stream` cannot — it is a WebSocket surface). */
type RestFunctionKind = "action" | "mutation" | "query";

/**
 * The `.expose({ rest: true })` tag stamped onto a registered procedure (runtime,
 * as `fn.expose`) or discovered from its builder chain (codegen, onto the
 * `FunctionIR`). Presence of `rest === true` is the ONLY thing that opts a
 * procedure into the surface — everything is default-closed.
 */
interface RestExposure {
    rest?: boolean;
}

/** One resolved REST endpoint: the transport method + URL path a procedure is reachable at. */
interface RestSurfaceEntry {
    functionPath: string;
    kind: RestFunctionKind;
    method: "GET" | "POST";
    name: string;
    namespace: string;
    path: string;
}

/**
 * Split a `<namespace>:<function>` procedure path into its parts. Returns
 * `undefined` for a malformed path (no single colon separator) so callers skip it
 * rather than mint a broken route.
 */
const splitFunctionPath = (functionPath: string): { name: string; namespace: string } | undefined => {
    const colon = functionPath.indexOf(":");

    if (colon <= 0 || colon >= functionPath.length - 1 || functionPath.indexOf(":", colon + 1) !== -1) {
        return undefined;
    }

    return { name: functionPath.slice(colon + 1), namespace: functionPath.slice(0, colon) };
};

/** The REST URL path for a procedure: `/_lunora/rest/<namespace>/<function>`. */
const restPathForFunction = (functionPath: string): string | undefined => {
    const parts = splitFunctionPath(functionPath);

    if (parts === undefined) {
        return undefined;
    }

    return `${REST_PATH_PREFIX}/${parts.namespace}/${parts.name}`;
};

/**
 * The primary HTTP method for a procedure kind: a `query` is a safe read → `GET`
 * (args ride the query string; the router also accepts `POST` with a JSON body for
 * large arg sets), a `mutation` / `action` is a state change → `POST`.
 */
const restMethodForKind = (kind: RestFunctionKind): "GET" | "POST" => (kind === "query" ? "GET" : "POST");

/**
 * Resolve the full REST surface from a list of procedures, filtering to the ones
 * opted in via `.expose({ rest: true })`. The single source of truth both the
 * runtime router and the OpenAPI emitter derive from — a `stream` procedure or a
 * malformed path is skipped. Ordered by path for stable enumeration.
 */
const describeRestSurface = (
    procedures: ReadonlyArray<{ exposure?: RestExposure; functionPath: string; kind: "action" | "mutation" | "query" | "stream" }>,
): RestSurfaceEntry[] => {
    const entries: RestSurfaceEntry[] = [];

    for (const procedure of procedures) {
        if (procedure.exposure?.rest !== true || procedure.kind === "stream") {
            continue;
        }

        const parts = splitFunctionPath(procedure.functionPath);
        const path = restPathForFunction(procedure.functionPath);

        if (parts === undefined || path === undefined) {
            continue;
        }

        entries.push({
            functionPath: procedure.functionPath,
            kind: procedure.kind,
            method: restMethodForKind(procedure.kind),
            name: parts.name,
            namespace: parts.namespace,
            path,
        });
    }

    entries.sort((a, b) => a.path.localeCompare(b.path));

    return entries;
};

export type { RestExposure, RestFunctionKind, RestSurfaceEntry };
export { describeRestSurface, REST_PATH_PREFIX, restMethodForKind, restPathForFunction, splitFunctionPath };

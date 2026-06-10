import type { JsonSchema } from "@cirrus/values";

import type { FunctionIR } from "./ir";
import sanitizeNamespace from "./paths";
import { argsObjectSchema, CIRRUS_ERROR_CODES } from "./schema-ir";

// ─── OpenRPC document assembly ───────────────────────────────────────────────
//
// OpenRPC (https://spec.open-rpc.org) is "the OpenAPI for JSON-RPC": instead of
// HTTP `paths`, it describes a flat `methods` array. Cirrus's RPC transport is
// JSON-RPC-shaped — one endpoint `POST /_cirrus/rpc` with an envelope of
// `{ functionPath, args }` — so OpenRPC is the RPC-native spec, complementing
// the OpenAPI document (which additionally covers `httpRouter()` REST routes;
// those are NOT representable in OpenRPC and are intentionally excluded here).

/** The OpenRPC dialect version this emitter targets. */
const OPENRPC_VERSION = "1.3.2";

/**
 * A best-effort result schema for a function with no declared `.output()`. The
 * return shape is TypeScript-inferred and not carried in the IR, so the method's
 * `result` is documented permissively with a note — mirroring the OpenAPI
 * emitter's success-response fallback.
 */
const inferredResultSchema = (): JsonSchema => {
    return { description: "Result is TS-inferred from the function's return type (no `.output()` declared); best-effort — any JSON." };
};

/**
 * Build one OpenRPC method object for a query/mutation/action. Cirrus passes a
 * single args object per call (`{ functionPath, args }`), so the method exposes
 * exactly one named param — `args` — whose `schema` is the function's
 * `v.*`-derived args object. Modelling it as a single object param (rather than
 * by-name positional params) matches the wire envelope 1:1, so the JSON-RPC
 * request example an OpenRPC tool renders is directly usable.
 *
 * `result` comes from `.output()` when declared, else a permissive inferred
 * schema. The method is namespaced/grouped by file via the `x-tags` extension
 * (OpenRPC has no first-class tag grouping), and the standard `CirrusError`
 * codes are enumerated under `errors` so clients can switch on `error.code`.
 */
const rpcMethod = (definition: FunctionIR): Record<string, unknown> => {
    const namespace = sanitizeNamespace(definition.filePath);
    const functionPath = `${namespace}:${definition.exportName}`;

    return {
        description: `Invoke the \`${definition.kind}\` \`${functionPath}\` over the Cirrus RPC envelope (POST /_cirrus/rpc, body \`{ "functionPath": "${functionPath}", "args": { … } }\`).`,
        errors: CIRRUS_ERROR_CODES.map((code, index) => {
            // OpenRPC error `code`s are integers; Cirrus's codes are strings, so
            // the machine-readable string is carried under `data.code` (what
            // clients switch on) and a synthetic stable integer fills `code`.
            return { code: -32_000 - index, data: { code }, message: code };
        }),
        name: functionPath,
        params: [
            {
                description: "The function's argument object (the RPC envelope's `args`).",
                name: "args",
                // A function with no declared args still takes an (empty) args
                // object; `required` reflects whether the function declares any
                // arguments at all.
                required: Object.keys(definition.args).length > 0,
                schema: argsObjectSchema(definition.args),
            },
        ],
        result: {
            name: "result",
            schema: inferredResultSchema(),
        },
        summary: `${definition.kind}: ${functionPath}`,
        "x-cirrus-function-kind": definition.kind,
        // OpenRPC has no first-class tag grouping; surface the file namespace as
        // an `x-tags` extension so tooling can group methods by source file.
        "x-tags": [{ name: namespace }],
    };
};

/** Inputs the OpenRPC emitter needs from a codegen run. */
interface OpenRpcEmitInput {
    functions: ReadonlyArray<FunctionIR>;
    /** `info.version`; defaults to `"0.0.0"` with a TODO when the project version is unknown. */
    version?: string;
}

/**
 * Emit an OpenRPC 1.x document describing Cirrus's JSON-RPC surface.
 *
 * Only the RPC `query`/`mutation`/`action` functions become `methods` — one per
 * function, `name` = `file:fn`. `internal` (off the external RPC path) and
 * `stream` (not invocable over the RPC envelope) are excluded, the same filter
 * the OpenAPI emitter applies. Each method's single `args` param is typed from
 * the function's `v.*` validators (`argsObjectSchema`); `result` is the
 * `.output()` schema when declared, else a best-effort inferred schema. The
 * standard `CirrusError` codes ride along under each method's `errors`.
 *
 * `httpRouter()` typed REST routes are deliberately omitted — OpenRPC is
 * RPC-only and cannot represent REST paths; the OpenAPI document is the spec
 * that covers the REST surface. Methods are sorted by name for stable output.
 * Returns the document as a pretty-printed JSON string.
 */
const emitOpenRpc = (input: OpenRpcEmitInput): string => {
    const version = input.version ?? "0.0.0";

    // Same filter as the OpenAPI emitter: `internal` and `stream` functions are
    // not invocable over the external RPC envelope.
    const rpcFunctions = input.functions.filter((definition) => definition.visibility !== "internal" && definition.kind !== "stream");

    const methods = rpcFunctions.map((definition) => rpcMethod(definition)).toSorted((a, b) => (a.name as string).localeCompare(b.name as string));

    const document = {
        info: {
            description: "Auto-generated from @cirrus/values-typed functions by @cirrus/codegen. Do not edit — run `cirrus codegen` to regenerate.",
            title: "Cirrus RPC",
            // TODO: thread the project/app package version through here when available.
            version,
        },
        methods,
        openrpc: OPENRPC_VERSION,
    };

    return `${JSON.stringify(document, undefined, 2)}\n`;
};

export { emitOpenRpc, OPENRPC_VERSION };
export type { OpenRpcEmitInput };

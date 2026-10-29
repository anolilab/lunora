import type { JsonSchema } from "@lunora/values";

import { moduleTagOf } from "./discover/modules";
import { GENERATED_HEADER } from "./emit";
import type { FunctionIR, ModuleIR } from "./ir";
import renderJsonData from "./json-data";
import { sanitizeNamespace } from "./paths";
import { LUNORA_ERROR_CODES, objectSchema, validatorIrToJsonSchema } from "./schema-ir";

// ─── OpenRPC document assembly ───────────────────────────────────────────────
//
// OpenRPC (https://spec.open-rpc.org) is "the OpenAPI for JSON-RPC": instead of
// HTTP `paths`, it describes a flat `methods` array. Lunora's RPC transport is
// JSON-RPC-shaped — one endpoint `POST /_lunora/rpc` with an envelope of
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
const inferredResultSchema: JsonSchema = {
    description: "Result is TS-inferred from the function's return type (no `.output()` declared); best-effort — any JSON.",
};

/**
 * The method description. A stream is not invoked over the RPC envelope: it opens
 * a WebSocket procedure stream and yields chunks, so the POST text would be wrong.
 */
const methodDescription = (kind: FunctionIR["kind"], functionPath: string): string =>
    kind === "stream"
        ? `Open the \`stream\` \`${functionPath}\` over the Lunora WebSocket. It yields chunks rather than one result, so its \`result\` schema is a placeholder.`
        : `Invoke the \`${kind}\` \`${functionPath}\` over the Lunora RPC envelope (POST /_lunora/rpc, body \`{ "functionPath": "${functionPath}", "args": { … } }\`).`;

/**
 * Build one OpenRPC method object for a query/mutation/action/stream. Lunora passes a
 * single args object per call (`{ functionPath, args }`), so the method exposes
 * exactly one named param — `args` — whose `schema` is the function's
 * `v.*`-derived args object. Modelling it as a single object param (rather than
 * by-name positional params) matches the wire envelope 1:1, so the JSON-RPC
 * request example an OpenRPC tool renders is directly usable.
 *
 * `result` comes from `.output()` when declared, else a permissive inferred
 * schema. The method is namespaced/grouped by file via the `x-tags` extension
 * (OpenRPC has no first-class tag grouping), and the standard `LunoraError`
 * codes are enumerated under `errors` so clients can switch on `error.code`.
 */
const rpcMethod = (definition: FunctionIR, tag: string): Record<string, unknown> => {
    const namespace = sanitizeNamespace(definition.filePath);
    const functionPath = `${namespace}:${definition.exportName}`;

    return {
        description: methodDescription(definition.kind, functionPath),
        errors: LUNORA_ERROR_CODES.map((code, index) => {
            // OpenRPC error `code`s are integers; Lunora's codes are strings, so
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
                schema: objectSchema(definition.args),
            },
        ],
        result: {
            name: "result",
            // `.output()` is the only declared return shape; without it the type
            // is TS-inferred and absent from the IR, so the schema stays the
            // permissive placeholder. Downstream generators (`lunora sdk
            // generate`) key off exactly this: a described-but-untyped schema
            // becomes an untyped return rather than an empty model.
            // A stream yields chunks over its WebSocket, so no single result is declared for it, whatever
            // an `.output()` validator (which a stream cannot take) would have said.
            schema: definition.output && definition.kind !== "stream" ? validatorIrToJsonSchema(definition.output) : inferredResultSchema,
        },
        summary: `${definition.kind}: ${functionPath}`,
        "x-lunora-function-kind": definition.kind,
        // The method `description` above is the generic RPC envelope text, so the author's
        // doc comment travels in its own extension. Present only when the export has one.
        ...(definition.description ? { "x-lunora-description": definition.description } : {}),
        // OpenRPC has no first-class tag grouping; surface the file namespace as
        // an `x-tags` extension so tooling can group methods by module (or source file).
        "x-tags": [{ name: tag }],
    };
};

/** Inputs the OpenRPC emitter needs from a codegen run. */
interface OpenRpcEmitInput {
    functions: ReadonlyArray<FunctionIR>;
    /** The app's modules, passed only once it declares one; a method in a module folder is tagged with the module instead of its file namespace. */
    modules?: ReadonlyArray<ModuleIR>;
    /** `info.version`; defaults to `"0.0.0"` with a TODO when the project version is unknown. */
    version?: string;
}

/**
 * Emit an OpenRPC 1.x document describing Lunora's JSON-RPC surface.
 *
 * `query`/`mutation`/`action`/`stream` functions become `methods` — one per
 * function, `name` = `file:fn`, with the kind in `x-lunora-function-kind`. `internal`
 * (off the external RPC path) is excluded. A stream's `result` is the description-only
 * placeholder: it has no single result. Each method's single `args` param is typed from
 * the function's `v.*` validators (`argsObjectSchema`); `result` is the
 * `.output()` schema when declared, else a best-effort inferred schema. The
 * standard `LunoraError` codes ride along under each method's `errors`.
 *
 * `httpRouter()` typed REST routes are deliberately omitted — OpenRPC is
 * RPC-only and cannot represent REST paths; the OpenAPI document is the spec
 * that covers the REST surface. Methods are sorted by name for stable output.
 * Returns the document as a plain object (the single source of truth
 * `emitOpenRpc` stringifies and `emitOpenRpcModule` inlines, so the `.json` and
 * `.ts` artifacts can never drift).
 */
const buildOpenRpcDocument = (input: OpenRpcEmitInput): Record<string, unknown> => {
    const version = input.version ?? "0.0.0";

    // `internal` functions stay off the external surface. A `stream` is listed so MCP and
    // other tooling can see it; the OpenAPI emitter still excludes it.
    const rpcFunctions = input.functions.filter((definition) => definition.visibility !== "internal");

    const modules = input.modules ?? [];
    const methods = rpcFunctions
        .map((definition) => rpcMethod(definition, moduleTagOf(modules, definition.filePath)))
        .toSorted((a, b) => (a.name as string).localeCompare(b.name as string));

    const document = {
        info: {
            description: "Auto-generated from @lunora/values-typed functions by @lunora/codegen. Do not edit — run `lunora codegen` to regenerate.",
            title: "Lunora RPC",
            version,
        },
        methods,
        openrpc: OPENRPC_VERSION,
    };

    return document;
};

/**
 * Emit the OpenRPC 1.x document as a pretty-printed JSON string
 * (`_generated/openrpc.json`) — the portable artifact for external tooling.
 */
const emitOpenRpc = (input: OpenRpcEmitInput): string => `${JSON.stringify(buildOpenRpcDocument(input), undefined, 2)}\n`;

/**
 * Emit the OpenRPC document as an importable TS module
 * (`_generated/openrpc.ts`) the worker entry imports and passes to
 * `createWorker({ openRpcSpec })`. The document is inlined as a `JSON.parse`
 * string (see {@link renderJsonData}), so the `.ts` and `.json` carry the same
 * content and regenerate together; its `methods` array grows with every
 * procedure, which as a literal fails `tsc` with TS2590 (#823). `document_` is
 * the object returned by {@link buildOpenRpcDocument} (reused, never recomputed).
 */
const emitOpenRpcModule = (document_: Record<string, unknown>): string =>
    `${GENERATED_HEADER}export const openRpcSpec = ${renderJsonData(document_, "Record<string, unknown>")};\n`;

export { buildOpenRpcDocument, emitOpenRpc, emitOpenRpcModule, OPENRPC_VERSION };
export type { OpenRpcEmitInput };

/**
 * Building a `ToolResult` from a value that came back over the wire.
 *
 * Its own module (rather than `./tools`) because two tool families need the
 * same JSON-safety guarantee: the deployment tools (`./tools`) and the
 * observability tools (`./observability-tools`). Keeping it here also keeps
 * `./observability-tools` off `./tools`, which would be an import cycle.
 */
import { getCatalogEntry, isInternalCode, LunoraError } from "@lunora/errors";

import { toBase64 } from "../../../shared/base64";
import type { ToolInputSchema, ToolResult } from "./tool-types";

/**
 * `JSON.stringify` replacer for a decoded RPC result. `LunoraClient` decodes
 * EVERY response (`rpc()` ends in `decodeWire(body.result)`), which revives
 * `v.int64()` leaves as real `bigint` and `v.bytes()`/typed-array columns as
 * `ArrayBuffer`/typed arrays — and that holds for admin reads too, which are
 * served WITHOUT a matching `encodeWire` but ride the same decode on the way
 * back. Raw `JSON.stringify` THROWS on a bigint (turning a successful call into
 * a tool error) and serializes an `ArrayBuffer` to `{}` / a `Uint8Array` to an
 * index-keyed object (silent corruption). Map every bigint → its decimal string
 * and every bytes leaf → base64 so the model sees a faithful value instead.
 */
const jsonResultReplacer = (_key: string, value: unknown): unknown => {
    if (typeof value === "bigint") {
        return value.toString();
    }

    if (value instanceof ArrayBuffer) {
        return toBase64(new Uint8Array(value));
    }

    if (ArrayBuffer.isView(value)) {
        const view = value;

        return toBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
    }

    return value;
};

/**
 * The JSON-safe projection of a decoded result — the same mapping
 * {@link jsonResultReplacer} applies to the text block, materialized as a
 * value. `structuredContent` is serialized by the transport, so an unconverted
 * bigint there would throw at the protocol layer instead of at the tool, taking
 * the whole response down rather than one field.
 *
 * Takes an object (never a bare value), which is both what MCP requires of
 * `structuredContent` and what makes `JSON.stringify` total here.
 */
const toJsonSafe = (value: Record<string, unknown>): Record<string, unknown> =>
    JSON.parse(JSON.stringify(value, jsonResultReplacer)) as Record<string, unknown>;

/** A text-only success result: the value as pretty JSON in one text block. */
const ok = (value: unknown): ToolResult => {
    // A void-returning mutation/action resolves to `undefined`, and
    // `JSON.stringify(undefined)` yields the JS value `undefined` (not a
    // string), which violates both `ToolResult.content[].text: string` and the
    // MCP `TextContent` contract. Emit the JSON `null` literal in that case.
    const text = value === undefined ? "null" : JSON.stringify(value, jsonResultReplacer, 2);

    return { content: [{ text, type: "text" }] };
};

/**
 * A success result carrying BOTH the text block and `structuredContent`.
 *
 * The text block is not redundant: `structuredContent` arrived in MCP revision
 * `2025-06-18`, and a client that negotiates an older revision (the SDK still
 * supports `2025-03-26` and `2024-11-05`) simply ignores the field. Emitting
 * both means one result shape works on every revision.
 */
const okStructured = (value: Record<string, unknown>): ToolResult => {
    return { ...ok(value), structuredContent: toJsonSafe(value) };
};

/**
 * An error result: `isError: true`, carrying `{ code, message }` both as
 * `structuredContent` and as one text block. Some clients render only the
 * structured form and some only the text, so both always say the same thing.
 *
 * `code` is a Lunora catalog code where one fits (`NOT_FOUND`, `FORBIDDEN`,
 * `BAD_REQUEST`, …) or a tool-specific code for the handshake refusals. The
 * message must be safe to show a model: pass only text this package wrote, never
 * a raw upstream error string (see {@link errorFromThrown}).
 */
const errorResult = (code: string, message: string): ToolResult => {
    return {
        content: [{ text: `${code}: ${message}`, type: "text" }],
        isError: true,
        structuredContent: { code, message },
    };
};

/** The one message a thrown error that is not a typed `LunoraError` is ever shown as. */
const UNEXPECTED_ERROR_MESSAGE = "the tool call failed unexpectedly";

/**
 * The error result for a thrown value. The disclosure rule lives here, once, so
 * no tool family can leak raw text.
 *
 * A `LunoraError` whose code the catalog marks `internal` shows only that
 * code's catalog title. The server already redacts those on the wire, and the
 * local copy must not undo it. Any other `LunoraError` shows its message: those
 * are either written by this package (the argument and allowlist refusals a model
 * needs to self-correct) or are the server's own public message for that code.
 *
 * Any other thrown value — a plain `Error`, a network failure, a string — is
 * `INTERNAL` with a fixed message. Its `.message` is not a contract and may carry
 * a URL, token or SQL fragment.
 */
const errorFromThrown = (error: unknown): ToolResult => {
    if (error instanceof LunoraError) {
        const { code } = error;

        return errorResult(code, isInternalCode(code) ? (getCatalogEntry(code)?.title ?? UNEXPECTED_ERROR_MESSAGE) : error.message);
    }

    // The client rebuilds a server's coded rejection as a plain `Error` carrying `code`. A code the
    // catalog knows is the server's public verdict, so it is kept; any other `code` (a socket's
    // `ECONNREFUSED`, say) is not a contract and falls through to the generic failure.
    if (error instanceof Error) {
        const { code } = error as { code?: unknown };

        if (typeof code === "string" && getCatalogEntry(code) !== undefined) {
            return errorResult(code, isInternalCode(code) ? (getCatalogEntry(code)?.title ?? UNEXPECTED_ERROR_MESSAGE) : error.message);
        }
    }

    return errorResult("INTERNAL", UNEXPECTED_ERROR_MESSAGE);
};

/** The JSON-Schema property for the `code` of an error result. */
const ERROR_CODE_PROPERTY: Record<string, unknown> = { description: "Set on an error result: the machine-readable error code.", type: "string" };

/** The JSON-Schema property for the `message` of an error result. */
const ERROR_MESSAGE_PROPERTY: Record<string, unknown> = { description: "Set on an error result: a message that is safe to show.", type: "string" };

/**
 * A tool's `outputSchema`, widened to admit the `{ code, message }` object an
 * error result carries.
 *
 * The MCP SDK client validates `structuredContent` against `outputSchema` even
 * when `isError` is set, so a schema that requires the success fields would
 * reject every failure of that tool. The error fields are added here and the
 * top level requires nothing, so the schema no longer enforces the success
 * fields. The typed helpers still produce them.
 */
const withErrorShape = (output: ToolInputSchema): ToolInputSchema => {
    return {
        properties: { code: ERROR_CODE_PROPERTY, message: ERROR_MESSAGE_PROPERTY, ...output.properties },
        type: "object",
    };
};

export { errorFromThrown, errorResult, ok, okStructured, withErrorShape };

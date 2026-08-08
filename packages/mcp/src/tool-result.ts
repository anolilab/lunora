/**
 * Building a `ToolResult` from a value that came back over the wire.
 *
 * Its own module (rather than `./tools`) because two tool families need the
 * same JSON-safety guarantee: the deployment tools (`./tools`) and the
 * observability tools (`./observability-tools`). Keeping it here also keeps
 * `./observability-tools` off `./tools`, which would be an import cycle.
 */
import type { ToolResult } from "./tool-types";

/**
 * Base64-encode bytes for the model-visible JSON, chunking to stay under
 * `String.fromCharCode`'s argument-count ceiling on large buffers (mirrors the
 * wire codec's own encoder).
 */
const bytesToBase64 = (bytes: Uint8Array): string => {
    let binary = "";
    const chunk = 0x80_00;

    for (let index = 0; index < bytes.length; index += chunk) {
        // eslint-disable-next-line unicorn/prefer-code-point -- byte values 0-255 -> latin1; fromCharCode is correct and faster here
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }

    return btoa(binary);
};

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
        return bytesToBase64(new Uint8Array(value));
    }

    if (ArrayBuffer.isView(value)) {
        const view = value;

        return bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
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

/** An error result: the message as tool output, per the MCP convention (never a rejection). */
const errorResult = (message: string): ToolResult => {
    return { content: [{ text: message, type: "text" }], isError: true };
};

export { bytesToBase64, errorResult, jsonResultReplacer, ok, okStructured, toJsonSafe };

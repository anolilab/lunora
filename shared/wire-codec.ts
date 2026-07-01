/**
 * Tagged value codec for the Lunora RPC/WS **transport**, shared (bundler-inlined,
 * like {@link file://./stable-key.ts}) by the client SDK (`@lunora/client`) and the
 * Durable Object runtime (`@lunora/do`). See `plans/086-wire-value-codec.md`.
 *
 * ## Why
 *
 * The wire is JSON (`JSON.stringify` / `JSON.parse`) with no reviver, but
 * `@lunora/values` defines value-kinds JSON cannot carry:
 *
 * - `v.bigint()` -> a real `bigint`. `JSON.stringify(1n)` **throws**.
 * - `v.bytes()` -> an `ArrayBuffer`. `JSON.stringify(new ArrayBuffer(8))` silently
 *   yields `{}` — silent data loss.
 *
 * Plus plan 078's custom scalars decode to typed arrays (`Float32Array`, ...) which
 * JSON also drops. This codec encodes exactly those leaves to a JSON-safe tagged
 * form and decodes them back, so a `bytes`/`bigint`/typed-array value round-trips
 * across the socket. Its design mirrors Cloudflare **Cap'n Web** (and its PR #201
 * `[bytes, b64, TypeName]` extension), but the two ends are both ours, so we use a
 * self-delimiting sentinel rather than Cap'n Web's bare-tag-array wire.
 *
 * ## Scope (deliberately tiny)
 *
 * Encoded: `bigint`, `ArrayBuffer`, typed-array views (`Uint8Array`, `Float32Array`,
 * ...), `NaN`/`+-Infinity`, and `undefined` **in array positions** (where JSON would
 * coerce it to `null`, losing information). NOT encoded — parity with Cap'n Web's
 * own limits and to keep the codec/security surface small: `Map`, `Set`, `RegExp`,
 * cyclic graphs, class instances, functions, capabilities. `Date` is out of scope
 * because `v.date()`/`v.timestamp()` are already epoch-ms **numbers** on the wire.
 *
 * ## Fidelity / back-compat
 *
 * A value with **no** special leaves encodes to a structurally identical JSON tree
 * (same bytes), so a pre-codec peer and a codec peer interop unchanged on pure-JSON
 * payloads. `undefined` object *fields* are dropped (matching `JSON.stringify`), so
 * plain objects stay byte-identical; only array-position `undefined` is tagged.
 */

/**
 * Self-delimiting tag. A JSON array is significant to the codec **only** when its
 * first element is exactly this string, so the collision surface is a user array
 * literally starting with the sentinel — handled by the `"arr"` escape below. The
 * `$...$` fence makes an accidental collision with real app data essentially
 * impossible while staying valid inside a JSON string.
 */
const TAG = "$lunora.wire$";

/** Constructors for the typed-array views the codec round-trips (keyed by name). */
const TYPED_ARRAY_CTORS: Record<string, { new (buffer: ArrayBuffer): ArrayBufferView }> = {
    BigInt64Array,
    BigUint64Array,
    Float32Array,
    Float64Array,
    Int8Array,
    Int16Array,
    Int32Array,
    Uint8Array,
    Uint8ClampedArray,
    Uint16Array,
    Uint32Array,
};

const toBase64 = (bytes: Uint8Array): string => {
    // Chunk to stay well under the argument-count ceiling of `String.fromCharCode`
    // on large buffers, without allocating an intermediate string per byte.
    let binary = "";
    const chunk = 0x8000;

    for (let index = 0; index < bytes.length; index += chunk) {
        binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
    }

    return btoa(binary);
};

const fromBase64 = (base64: string): Uint8Array => {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);

    for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.codePointAt(index) ?? 0;
    }

    return bytes;
};

/**
 * Encode `value` into a JSON-safe tree, tagging the leaves JSON cannot represent.
 * Pure and recursive; no I/O. Trees only (no cycle detection — a cyclic input
 * throws via the recursion, same as `JSON.stringify`).
 */
const encodeWire = (value: unknown): unknown => {
    if (value === undefined) {
        // Callers encode object fields by iterating own keys and skipping
        // `undefined` (see below), so a bare `undefined` here is an array element
        // (or a top-level value) where the position must be preserved.
        return [TAG, "undefined"];
    }

    if (value === null) {
        return null;
    }

    const kind = typeof value;

    if (kind === "bigint") {
        return [TAG, "bigint", (value as bigint).toString()];
    }

    if (kind === "number") {
        const numeric = value as number;

        if (Number.isNaN(numeric)) {
            return [TAG, "nan"];
        }

        if (numeric === Infinity) {
            return [TAG, "inf"];
        }

        if (numeric === -Infinity) {
            return [TAG, "-inf"];
        }

        return numeric;
    }

    if (kind !== "object") {
        // string, boolean — JSON-safe as-is. (function/symbol fall here too; they
        // are not valid values and JSON.stringify would drop them — leave that.)
        return value;
    }

    if (value instanceof ArrayBuffer) {
        return [TAG, "bytes", toBase64(new Uint8Array(value)), "ArrayBuffer"];
    }

    if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView;
        const ctorName = view.constructor.name;
        const bytes = new Uint8Array(view.buffer, view.byteOffset, view.byteLength);

        // `Uint8Array` keeps Cap'n Web's 2-element form; every other view carries
        // its constructor name so `decodeWire` rebuilds the exact view type.
        return ctorName === "Uint8Array" ? [TAG, "bytes", toBase64(bytes)] : [TAG, "bytes", toBase64(bytes), ctorName];
    }

    if (Array.isArray(value)) {
        const encoded = value.map((item) => encodeWire(item));

        // Escape a user array that would otherwise be mistaken for a tagged value
        // (its first element is literally the sentinel string). Wrap it as an
        // `"arr"`-tagged payload so the decoder restores the original array.
        return encoded.length > 0 && encoded[0] === TAG ? [TAG, "arr", encoded] : encoded;
    }

    // Plain object — recurse over own enumerable string keys. Drop `undefined`
    // fields (matches `JSON.stringify`, keeps pure-JSON objects byte-identical).
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
        const field = source[key];

        if (field !== undefined) {
            result[key] = encodeWire(field);
        }
    }

    return result;
};

/** Inverse of {@link encodeWire}: revive tagged leaves back to their JS values. */
const decodeWire = (value: unknown): unknown => {
    if (value === null || typeof value !== "object") {
        return value;
    }

    if (Array.isArray(value)) {
        if (value[0] === TAG) {
            const tag = value[1] as string;

            switch (tag) {
                case "-inf": {
                    return -Infinity;
                }
                case "arr": {
                    return (value[2] as unknown[]).map((item) => decodeWire(item));
                }
                case "bigint": {
                    return BigInt(value[2] as string);
                }
                case "bytes": {
                    const bytes = fromBase64(value[2] as string);
                    const ctorName = (value[3] as string | undefined) ?? "Uint8Array";

                    if (ctorName === "ArrayBuffer") {
                        // Return a right-sized ArrayBuffer (the Uint8Array may view
                        // a larger backing buffer after base64 round-trip).
                        return bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
                    }

                    const Ctor = TYPED_ARRAY_CTORS[ctorName];

                    // Unknown view constructor (forward-compat) — hand back the raw bytes.
                    return Ctor ? new Ctor(bytes.slice().buffer) : bytes;
                }
                case "inf": {
                    return Infinity;
                }
                case "nan": {
                    return Number.NaN;
                }
                case "undefined": {
                    return undefined;
                }
                default: {
                    // Unknown tag (forward-compat): treat as an ordinary array.
                    return value.map((item) => decodeWire(item));
                }
            }
        }

        return value.map((item) => decodeWire(item));
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
        result[key] = decodeWire(source[key]);
    }

    return result;
};

export { decodeWire, encodeWire };

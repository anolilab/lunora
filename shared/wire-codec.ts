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
 * Encoded: `bigint`, `Date`, `Error` (name/message/own-props, no stack),
 * `ArrayBuffer`, typed-array views (`Uint8Array`, `Float32Array`, ...),
 * `NaN`/`+-Infinity`, and `undefined` **in array positions** (where JSON would
 * coerce it to `null`, losing information). NOT encoded — parity with Cap'n Web's
 * own limits and to keep the codec/security surface small: cyclic graphs, class
 * instances, functions, capabilities. `Map`/`Set`/`RegExp` are **rejected with a
 * TypeError** (as Cap'n Web refuses them) rather than silently encoded to `{}`, so
 * an unsupported value fails loud at the send site. Nesting deeper than
 * {@link MAX_DEPTH} throws a `RangeError` (Cap'n Web's 64-level cap) so a hostile
 * deeply-nested payload can't blow the recursion stack.
 *
 * `Error` is encoded (as Cap'n Web does) because its `name`/`message`/`stack` are
 * non-enumerable — the plain-object branch would drop them and yield a bare `{}`,
 * silently losing the error. An `Error` embedded in a payload (an action's return,
 * whisper `data`, or a `LunoraError`'s `data`) round-trips as a real Error with its
 * name, message, and own props. `stack` is deliberately omitted (untrusted client;
 * the RPC error path redacts stacks separately). This is distinct from the
 * transport's top-level thrown-error envelope, which stays redacted.
 *
 * `Date` is encoded (as Cap'n Web does) even though `v.date()`/`v.timestamp()` are
 * already epoch-ms **numbers** on the wire: those cover only *schema-validated* args.
 * A bare `Date` in an un-validated position (whisper `data`, an action's return, a
 * stream arg) would otherwise recurse into the plain-object branch — a `Date` has no
 * own enumerable keys, so it would silently encode to `{}` (total data loss, worse
 * than `JSON.stringify`'s ISO string). Tagging it as epoch-ms round-trips it exactly.
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

/**
 * Max nesting depth the codec encodes/decodes, mirroring Cap'n Web's own 64-level
 * cap. Without it a hostile or accidental deeply-nested payload blows the recursion
 * stack — surfacing as a contextless `RangeError` on the *server* for inbound args.
 * This throws a clean, bounded error at the offending level instead. Real payloads
 * are far shallower than 64.
 */
const MAX_DEPTH = 64;

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

/**
 * Standard `Error` constructors the codec rebuilds by name (all single-arg
 * `(message)` shapes). An unknown name (a custom subclass like `LunoraError`)
 * falls back to a plain `Error` with `.name` restored — the message and own
 * props still survive, only the exact prototype is lost. `AggregateError` is
 * omitted deliberately: its `(errors, message)` signature differs, so it takes
 * the same generic-`Error` fallback rather than a mis-constructed instance.
 */
const ERROR_CTORS: Record<string, { new (message?: string): Error }> = {
    Error,
    EvalError,
    RangeError,
    ReferenceError,
    SyntaxError,
    TypeError,
    URIError,
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
const encodeWire = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_DEPTH) {
        throw new RangeError(`wire-codec: value nesting exceeds the ${MAX_DEPTH}-level limit`);
    }

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

    if (value instanceof Date) {
        // Epoch-ms (matches `v.date()`/`v.timestamp()`'s own wire form). An invalid
        // Date's `getTime()` is `NaN`, which raw JSON coerces to `null` (→ epoch 0);
        // route the epoch through the codec's own number handling so `NaN` survives
        // as a `["nan"]` tag and `decodeWire` rebuilds an invalid Date exactly.
        return [TAG, "date", encodeWire((value as Date).getTime(), depth + 1)];
    }

    if (value instanceof Error) {
        // An Error's `name`/`message`/`stack` are non-enumerable, so the plain-object
        // branch would drop them and yield a bare `{}` (or just the custom props) —
        // the error identity silently lost. Encode name + message + own enumerable
        // props (which carry app-set fields like a `LunoraError`'s `code`/`data`), as
        // Cap'n Web does. `stack` is intentionally omitted: the client is untrusted,
        // and a server stack in a payload would be an internal-detail leak (the RPC
        // error path already redacts stacks separately).
        const error = value as Error & Record<string, unknown>;
        const properties: Record<string, unknown> = {};

        for (const key of Object.keys(error)) {
            if (error[key] !== undefined) {
                properties[key] = encodeWire(error[key], depth + 1);
            }
        }

        return [TAG, "error", error.name, error.message, properties];
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
        const encoded = value.map((item) => encodeWire(item, depth + 1));

        // Escape a user array that would otherwise be mistaken for a tagged value
        // (its first element is literally the sentinel string). Wrap it as an
        // `"arr"`-tagged payload so the decoder restores the original array.
        return encoded.length > 0 && encoded[0] === TAG ? [TAG, "arr", encoded] : encoded;
    }

    // Fail loud on the object types Cap'n Web also refuses (`Map`, `Set`, `RegExp`).
    // They have no own enumerable keys, so the plain-object branch below would
    // silently encode them to `{}` — corruption a caller can't detect. A thrown
    // TypeError surfaces the unsupported value at the send site instead. (This
    // does not catch arbitrary class instances: those keep JSON's own lossy
    // behavior, matching the codec's "trees only" scope.)
    if (value instanceof Map || value instanceof Set || value instanceof RegExp) {
        throw new TypeError(`wire-codec: cannot encode a ${value.constructor.name} — unsupported over the Lunora wire (like Cap'n Web).`);
    }

    // Plain object — recurse over own enumerable string keys. Drop `undefined`
    // fields (matches `JSON.stringify`, keeps pure-JSON objects byte-identical).
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
        const field = source[key];

        if (field !== undefined) {
            result[key] = encodeWire(field, depth + 1);
        }
    }

    return result;
};

/** Inverse of {@link encodeWire}: revive tagged leaves back to their JS values. */
const decodeWire = (value: unknown, depth = 0): unknown => {
    if (depth > MAX_DEPTH) {
        throw new RangeError(`wire-codec: value nesting exceeds the ${MAX_DEPTH}-level limit`);
    }

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
                    return (value[2] as unknown[]).map((item) => decodeWire(item, depth + 1));
                }
                case "bigint": {
                    return BigInt(value[2] as string);
                }
                case "date": {
                    return new Date(decodeWire(value[2], depth + 1) as number);
                }
                case "error": {
                    const name = value[2] as string;
                    const message = value[3] as string;
                    // Allow-list lookup only (`Object.hasOwn`), never a bare bracket
                    // index — a wire-supplied name must not walk the prototype chain
                    // and dispatch `new` to an unexpected target.
                    const Ctor = (Object.hasOwn(ERROR_CTORS, name) ? ERROR_CTORS[name] : undefined) ?? Error;
                    const error = new Ctor(message) as Error & Record<string, unknown>;

                    // Restore the original name for a custom subclass that fell back
                    // to the generic `Error` ctor (e.g. `LunoraError`).
                    if (error.name !== name) {
                        Object.defineProperty(error, "name", { configurable: true, value: name, writable: true });
                    }

                    Object.assign(error, decodeWire(value[4], depth + 1) as Record<string, unknown>);

                    return error;
                }
                case "bytes": {
                    const bytes = fromBase64(value[2] as string);
                    const ctorName = (value[3] as string | undefined) ?? "Uint8Array";

                    if (ctorName === "ArrayBuffer") {
                        // Return a right-sized ArrayBuffer (the Uint8Array may view
                        // a larger backing buffer after base64 round-trip).
                        return bytes.buffer.byteLength === bytes.byteLength ? bytes.buffer : bytes.slice().buffer;
                    }

                    // Resolve ONLY against the allow-list's own keys — a bracket
                    // lookup with an attacker-controlled name would otherwise walk the
                    // prototype chain (`"constructor"`, `"toString"`, …) and dispatch
                    // `new` to an unexpected target. `Object.hasOwn` pins it to the
                    // known typed-array constructors.
                    const Ctor = Object.hasOwn(TYPED_ARRAY_CTORS, ctorName) ? TYPED_ARRAY_CTORS[ctorName] : undefined;

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
                    return value.map((item) => decodeWire(item, depth + 1));
                }
            }
        }

        return value.map((item) => decodeWire(item, depth + 1));
    }

    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
        result[key] = decodeWire(source[key], depth + 1);
    }

    return result;
};

export { decodeWire, encodeWire };

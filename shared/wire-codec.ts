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
 * Encoded: `bigint`, `Date`, `Error` (name/message/own-props/`cause`, no stack),
 * `URL`, `Map`, `Set`, `ArrayBuffer`, typed-array views (`Uint8Array`,
 * `Float32Array`, ...), `NaN`/`+-Infinity`, and `undefined` **in array positions**
 * (where JSON would coerce it to `null`, losing information). NOT encoded: cyclic
 * graphs, functions, capabilities, and any other non-plain object (`RegExp`,
 * `Headers`, a class instance, …) — these have no own enumerable keys, so rather
 * than silently encode to `{}` they are **rejected with a TypeError** (only plain
 * objects and arrays fall through). Nesting deeper than {@link MAX_DEPTH} throws a
 * `RangeError` (Cap'n Web's 64-level cap) so a hostile deeply-nested payload can't
 * blow the recursion stack.
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

import { fromBase64, toBase64 } from "./base64";

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

/**
 * Max decimal digits accepted for a wire `bigint` on decode. `BigInt()` decimal
 * parsing is superlinear, so a multi-megabyte digit string from an untrusted peer
 * would block the event loop (Cap'n Web #184/#185). A real `v.bigint()` is a
 * handful of digits; 1024 (a ~3400-bit integer) is far beyond any legitimate use
 * yet nowhere near the DoS range. Applied only on decode (the untrusted path).
 */
const MAX_BIGINT_DIGITS = 1024;

/** Object keys that must never be written by assignment on decode — `__proto__` invokes the prototype setter, polluting the decoded object (Cap'n Web #190). */
const UNSAFE_KEY = "__proto__";

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

/**
 * The codec's definition of a plain object: an `Object.prototype` or
 * null-prototype object. Arrays fail it (their prototype is `Array.prototype`),
 * as do `Date`, `Map`, `Set`, `ArrayBuffer` and every typed-array view.
 *
 * Exported because it is the boundary between "a document" and "a value that
 * merely decoded to an object". Callers that parse a stored/received blob need
 * exactly this test, and testing for `!Array.isArray` instead is a trap: it is
 * sufficient for a bare `JSON.parse` (whose only non-plain root is an array) but
 * NOT after {@link decodeWire}, which turns a root-level tagged array into a
 * `Uint8Array`/`Date`/`Map` that passes an array-only check.
 */
const isPlainObject = (value: unknown): value is Record<string, unknown> => {
    if (value === null || typeof value !== "object") {
        return false;
    }

    const proto = Object.getPrototypeOf(value) as object | null;

    return proto === null || proto === Object.prototype;
};

/**
 * Encode `value` into a JSON-safe tree, tagging the leaves JSON cannot represent.
 * Pure and recursive; no I/O. Trees only (no cycle detection — a cyclic input
 * throws via the recursion, same as `JSON.stringify`).
 */
/**
 * Would {@link encodeWire} change this value, or is it already the JSON it will
 * become?
 *
 * `encodeWire` is identity for pure JSON — it says so, and the row store depends
 * on it: a document with no wire-typed leaf must encode byte-identically to
 * plain `JSON.stringify`, or the OCC compare-and-swap stops matching stored
 * rows. But identity is not free. It walks the tree and rebuilds every object and
 * array along the way, and the caller almost always throws that copy straight at
 * `JSON.stringify`. Profiling the DO write path put `encodeDocJson` at 8.2% of
 * it, most of that the discarded copy.
 *
 * This answers the same question with a read-only walk, so the common case can
 * stringify the original and allocate nothing.
 *
 * **It is deliberately conservative.** Every branch that is not *provably*
 * identity answers `true` — a false positive costs one wasted encode, while a
 * false negative writes different bytes than the store expects, which is silent
 * corruption. It lives next to `encodeWire` for the same reason: the two must
 * agree, so they have to be read together.
 * `packages/shard-engine/__tests__/needs-wire-encoding.test.ts` fuzzes the
 * property that matters — `needsWireEncoding(v) === false` implies
 * `JSON.stringify(encodeWire(v)) === JSON.stringify(v)`.
 * @returns `true` when the value must go through {@link encodeWire}
 */
const needsWireEncoding = (value: unknown, depth = 0): boolean => {
    // Past the cap `encodeWire` raises a RangeError, and a cyclic graph reaches
    // here too. Both belong on the encoding path so the real error is thrown.
    if (depth > MAX_DEPTH) {
        return true;
    }

    if (value === null) {
        return false;
    }

    const kind = typeof value;

    if (kind === "string" || kind === "boolean") {
        return false;
    }

    if (kind === "number") {
        // NaN / ±Infinity are tagged. `-0` is NOT: `encodeWire` returns it as-is
        // and `JSON.stringify` renders both `-0` and `0` as "0", so it is identity
        // here even though `stableStringify` (a different contract) tags it.
        return !Number.isFinite(value);
    }

    if (kind !== "object") {
        // bigint, undefined, function, symbol.
        return true;
    }

    if (Array.isArray(value)) {
        // An array whose first element IS the sentinel gets wrapped as an
        // `"arr"` payload. Only a string equal to the sentinel encodes to it, so
        // testing the raw element is the same test `encodeWire` makes on the
        // encoded one.
        if (value.length > 0 && value[0] === TAG) {
            return true;
        }

        // `undefined` in an array POSITION is tagged, where `JSON.stringify`
        // would write `null` — the one place the two disagree on a value both
        // can represent.
        return value.some((item) => item === undefined || needsWireEncoding(item, depth + 1));
    }

    if (!isPlainObject(value)) {
        // Date, Map, Set, URL, bytes, Error — and class instances, which
        // `encodeWire` refuses outright.
        return true;
    }

    // A literal `__proto__` field is installed with `defineProperty` on the
    // encoding path. Both forms stringify the same today, but the handling is
    // deliberate enough that routing it through the real encoder is the safer
    // reading of "not provably identity".
    if (Object.hasOwn(value, UNSAFE_KEY)) {
        return true;
    }

    for (const key of Object.keys(value)) {
        const field = value[key];

        // Both sides drop an `undefined` object field, so it is not a difference.
        if (field !== undefined && needsWireEncoding(field, depth + 1)) {
            return true;
        }
    }

    return false;
};

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
            if (error[key] === undefined) {
                continue;
            }

            const encoded = encodeWire(error[key], depth + 1);

            // Same `UNSAFE_KEY` guard as the plain-object branch below and both
            // decode branches: a plain `properties[key] = …` for `"__proto__"`
            // fires the prototype SETTER, so the field never becomes an own
            // property (it re-encodes as `{}`, silently dropped) and `properties`
            // itself ends up with an attacker-chosen prototype. `defineProperty`
            // installs it as an own data property instead (Cap'n Web #190).
            if (key === UNSAFE_KEY) {
                Object.defineProperty(properties, key, { configurable: true, enumerable: true, value: encoded, writable: true });
            } else {
                properties[key] = encoded;
            }
        }

        const encodedError: unknown[] = [TAG, "error", error.name, error.message, properties];

        // `cause` (from `new Error(msg, { cause })`) is a non-enumerable own prop, so
        // the `Object.keys` loop above misses it — carry it in a positional slot so an
        // error chain survives. Absent when no cause was set (keeps the 5-element form).
        if (error.cause !== undefined) {
            encodedError.push(encodeWire(error.cause, depth + 1));
        }

        return encodedError;
    }

    if (value instanceof URL) {
        return [TAG, "url", value.href];
    }

    if (value instanceof Map) {
        // Entries recurse (keys and values), so bigint/bytes/nested structures in a
        // Map round-trip. `decodeWire` rebuilds a real `Map`.
        return [TAG, "map", [...(value as Map<unknown, unknown>).entries()].map(([k, v]) => [encodeWire(k, depth + 1), encodeWire(v, depth + 1)])];
    }

    if (value instanceof Set) {
        return [TAG, "set", [...(value as Set<unknown>)].map((item) => encodeWire(item, depth + 1))];
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

    // Fail loud on any remaining non-plain object (`RegExp`, `Headers`, a class
    // instance, …). These have no own enumerable string keys, so the plain-object
    // branch below would silently encode them to `{}` — corruption a caller can't
    // detect. Only plain objects (`Object.prototype` or a null prototype) fall
    // through. A thrown TypeError surfaces the unsupported value at the send site.
    if (!isPlainObject(value)) {
        const name = (value as { constructor?: { name?: string } }).constructor?.name ?? "value";

        throw new TypeError(
            `wire-codec: cannot encode a ${name} over the Lunora wire — only plain objects, arrays, and the supported built-ins (Date, Error, URL, Map, Set, ArrayBuffer/typed arrays, bigint) round-trip`,
        );
    }

    // Plain object — recurse over own enumerable string keys. Drop `undefined`
    // fields (matches `JSON.stringify`, keeps pure-JSON objects byte-identical).
    const source = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};

    for (const key of Object.keys(source)) {
        const field = source[key];

        if (field === undefined) {
            continue;
        }

        const encoded = encodeWire(field, depth + 1);

        // Mirror the decode side's `UNSAFE_KEY` handling. A plain
        // `result[key] = …` for `"__proto__"` fires the prototype SETTER
        // instead of creating an own property, so the field is silently
        // dropped from the output — a `JSON.parse`d document carrying a
        // literal `__proto__` field would lose it on every re-encode, while
        // `decodeWire` faithfully preserves it. `defineProperty` installs it
        // as an own data property, so it survives without polluting anything.
        if (key === UNSAFE_KEY) {
            Object.defineProperty(result, key, { configurable: true, enumerable: true, value: encoded, writable: true });
        } else {
            result[key] = encoded;
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
                    // Bound + validate before `BigInt()`: its decimal parse is
                    // superlinear, so an over-long or non-numeric digit string from
                    // an untrusted peer would block the event loop. `\d` is ASCII-only.
                    const raw = value[2];

                    if (typeof raw !== "string" || raw.length > MAX_BIGINT_DIGITS || !/^-?\d+$/.test(raw)) {
                        throw new RangeError(`wire-codec: invalid or over-long bigint (max ${MAX_BIGINT_DIGITS} digits)`);
                    }

                    return BigInt(raw);
                }
                case "date": {
                    // A conforming encoder always emits an epoch-ms NUMBER in the
                    // payload slot. The arity check alone was not that guard: it
                    // stopped `[TAG,"date"]` (which decoded `undefined` into an
                    // Invalid Date and re-encoded as `[TAG,"date",[TAG,"nan"]]`)
                    // while `[TAG,"date",null]` still coerced to epoch 0 and
                    // `[TAG,"date","abc"]` to an Invalid Date — inventing a
                    // timestamp out of a malformed frame either way, which is the
                    // silent corruption this codec exists to refuse. Every non-JS
                    // port already rejects a non-number epoch; this makes the
                    // reference agree rather than asking eight languages to
                    // reproduce `new Date(null)`.
                    const epoch = decodeWire(value[2], depth + 1);

                    if (typeof epoch !== "number") {
                        throw new TypeError("wire-codec: malformed date — epoch must be a number");
                    }

                    return new Date(epoch);
                }
                case "map": {
                    const entries = value[2] as unknown[];

                    return new Map(
                        entries.map((entry) => {
                            // A conforming encoder always emits a 2-element entry.
                            // Destructuring a shorter one would silently invent an
                            // `undefined` value from malformed wire input — the exact
                            // silent corruption this codec promises not to do — so a
                            // malformed entry is refused instead.
                            if (!Array.isArray(entry) || entry.length !== 2) {
                                throw new TypeError("wire-codec: malformed map entry — expected a [key, value] pair");
                            }

                            return [decodeWire(entry[0], depth + 1), decodeWire(entry[1], depth + 1)] as [unknown, unknown];
                        }),
                    );
                }
                case "set": {
                    return new Set((value[2] as unknown[]).map((item) => decodeWire(item, depth + 1)));
                }
                case "url": {
                    // `new URL` ToString-coerces, so an asserted non-string href
                    // was accepted whenever its coercion happened to parse:
                    // `[TAG,"url",["http://x/"]]` decoded to a real URL and
                    // re-encoded as the string form. Every port refuses a
                    // non-string href; so does this one.
                    const href = value[2];

                    if (typeof href !== "string") {
                        throw new TypeError("wire-codec: malformed url — href must be a string");
                    }

                    return new URL(href);
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

                    // Merge the decoded props key-wise rather than via `Object.assign`.
                    // `decodeWire` may return an object carrying `__proto__` as an OWN
                    // enumerable data property (see the object branch below); a bare
                    // `Object.assign(error, props)` would copy it with `[[Set]]`
                    // semantics and fire the prototype setter, swapping this Error's
                    // prototype. Mirror the object branch's `UNSAFE_KEY` guard so the
                    // value lands as an own data property instead (Cap'n Web #190).
                    const props = decodeWire(value[4], depth + 1) as Record<string, unknown>;

                    // The props slot must be a real object. `Object.keys` on a
                    // primitive is not an error in JS — it enumerates a string's
                    // indices — so `[TAG,"error","E","m","ab"]` used to decode as
                    // `{ 0: "a", 1: "b" }` here while every port produced `{}`. That
                    // divergence is a JS accident, not a contract, and the honest
                    // fix is to refuse the frame rather than teach eight languages
                    // to reproduce it.
                    if (props === null || typeof props !== "object" || Array.isArray(props)) {
                        throw new TypeError("wire-codec: malformed error — props must be an object");
                    }

                    for (const key of Object.keys(props)) {
                        if (key === UNSAFE_KEY) {
                            Object.defineProperty(error, key, { configurable: true, enumerable: true, value: props[key], writable: true });
                        } else {
                            error[key] = props[key];
                        }
                    }

                    // Restore a positional `cause` (6th slot) as a non-enumerable own
                    // property, matching a native `Error`'s `cause` descriptor.
                    if (value.length > 5) {
                        Object.defineProperty(error, "cause", { configurable: true, value: decodeWire(value[5], depth + 1), writable: true });
                    }

                    return error;
                }
                case "bytes": {
                    // Type-CHECK, not a type-assert: `atob` takes a string, so an
                    // asserted `null`/`true`/`1234` was ToString-coerced and
                    // decoded as the base64 of `"null"` — three invented bytes
                    // that re-encode as a legitimate-looking `bytes` tag. The
                    // sibling `date`, `map` and `error` cases each refuse their
                    // slot the same way, as do all eight ports.
                    const encoded = value[2];

                    if (typeof encoded !== "string") {
                        throw new TypeError("wire-codec: malformed bytes — payload must be a base64 string");
                    }

                    const bytes = fromBase64(encoded);
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
        const decoded = decodeWire(source[key], depth + 1);

        // `JSON.parse` puts a wire `"__proto__"` key as an OWN property, but
        // assigning it here would invoke the prototype setter and pollute `result`
        // (and its prototype chain). Define it as a plain own data property instead
        // so the value round-trips faithfully without any pollution (Cap'n Web #190).
        if (key === UNSAFE_KEY) {
            Object.defineProperty(result, key, { configurable: true, enumerable: true, value: decoded, writable: true });
        } else {
            result[key] = decoded;
        }
    }

    return result;
};

/**
 * Parse a stored JSON blob back into a document: `JSON.parse`, then
 * {@link decodeWire}, then {@link isPlainObject}. Returns `undefined` for
 * anything that is not a document — unparseable text, a malformed tag
 * (`decodeWire` throws on an over-long bigint or past the nesting cap), or a
 * root that decodes to a non-plain object.
 *
 * Never throws, because its callers are read paths that must degrade rather
 * than fail: a display surface shows the row unexpanded, an editor falls back
 * to the row's own columns. A caller that needs to distinguish "bad JSON" from
 * "not a document" — to report which — should use {@link decodeWire} and
 * {@link isPlainObject} directly and keep its own `try`.
 */
const decodeDocument = (text: string): Record<string, unknown> | undefined => {
    try {
        const value = decodeWire(JSON.parse(text));

        return isPlainObject(value) ? value : undefined;
    } catch {
        return undefined;
    }
};

/**
 * {@link encodeWire} an outbound call's `args`, re-throwing the bare codec error
 * with the calling surface and the target function attached.
 *
 * Every producer of a Lunora call envelope encodes here — `@lunora/client`'s
 * service binding, `@lunora/dispatch`'s runner, `ctx.scheduler` (from a shard and
 * from an HTTP action), and the workpool. `encodeWire` REJECTS any non-plain
 * object (a `RegExp`, a `Headers`, a class instance, one with a working
 * `toJSON()`), where `JSON.stringify` used to swallow it into `{}`. Loud beats
 * silently wrong, but the codec's own message names only the offending type: an
 * unattributed `TypeError` out of `pool.enqueue` or a scheduled job's log line
 * cannot be traced back to the call that carried the bad argument. `label` is the
 * surface (`@lunora/queue`, `ctx.scheduler.runAt`), `path` the target function.
 */
const encodeArgsOrThrow = (label: string, path: string, args: unknown): unknown => {
    try {
        return encodeWire(args);
    } catch (error: unknown) {
        throw new TypeError(
            `${label}: cannot encode args for '${path}' — ${error instanceof Error ? error.message : String(error)}`,
            error instanceof Error ? { cause: error } : undefined,
        );
    }
};

export { decodeDocument, decodeWire, encodeArgsOrThrow, encodeWire, isPlainObject, needsWireEncoding, TAG as WIRE_TAG };

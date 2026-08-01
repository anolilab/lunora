/**
 * Codec for the `x-lunora-userid` / `x-lunora-identity` headers the worker
 * forwards to a shard as verified caller identity.
 *
 * HTTP header values are WebIDL `ByteString`s: `new Request(...)`/`Headers`
 * throws a `TypeError` for any code unit above 255. The worker used to set
 * `x-lunora-identity` to raw `JSON.stringify(claims)` and `x-lunora-userid` to
 * the raw id string, so a `resolveIdentity` returning any claim (or id) with a
 * non-Latin-1 character — a CJK/Cyrillic/Arabic name, an emoji, an IDN — made
 * the `Request` construction throw before the shard was ever reached, turning
 * into an opaque INTERNAL 500 for every RPC/batch/fan-out/REST/dispatch call
 * for that user. Latin-1-only text (including accented Latin letters) survives
 * unencoded, which is why local testing with ASCII-ish names misses this.
 *
 * `encodeIdentityHeader` UTF-8-encodes the claims JSON and base64url-encodes
 * the bytes, so the header value is always plain ASCII (every code unit <=
 * 127, well under the 255 ceiling) regardless of what the claims contain.
 * `decodeIdentityHeader` sniffs the encoding: `raw[0] === "{"` means an
 * unencoded legacy value (forwarded by a worker that hasn't picked up this
 * codec yet, or a Latin-1-only claims set that happened to be sent raw before
 * this change) and is parsed as JSON directly; anything else is treated as
 * base64url and decoded first. This makes rollout order-independent — an old
 * producer and a new consumer (or vice versa) both still work.
 *
 * `encodeUserIdHeader` / `decodeUserIdHeader` do the equivalent for the bare
 * `x-lunora-userid` string, which has no JSON envelope to sniff a `{` on. A
 * userId is Latin-1-safe in the overwhelming common case (opaque ids, emails,
 * UUIDs), so it is forwarded byte-for-byte unchanged whenever every code unit
 * is <= 255 AND it doesn't already start with `=` (the encoded-form sentinel
 * below) — keeping the header human-readable and avoiding a size regression
 * for the common path. Only a userId that needs encoding (a non-Latin-1
 * character, or one that would collide with the sentinel) is prefixed with
 * `=` and base64url-encoded; `decodeUserIdHeader` inverts this by checking for
 * the leading `=`.
 *
 * Every decode fails soft to `undefined` on malformed input — no `raw[0] ===
 * "{"` legacy JSON, no valid base64url, or a decoded-but-non-object JSON value
 * — mirroring `parseIdentityHeader`'s pre-existing posture in
 * `packages/do/src/admin-rpc-args.ts` (a garbled/absent identity header
 * degrades the caller to anonymous rather than throwing).
 *
 * Deliberately **not** a package: consumers (`@lunora/runtime`,
 * `@lunora/dispatch`, `@lunora/do`, `@lunora/agent`) import this file by
 * relative path and the bundler (packem/rollup) inlines it — no runtime
 * dependency edge between otherwise-unrelated packages. Keep it genuinely
 * zero-dependency (only relative/built-in imports) or inlining breaks.
 * Consumers must drop `outDir`/`rootDir` from their `tsconfig.json` (a set
 * `rootDir` raises TS6059 for this out-of-package file under `tsc --noEmit`).
 */
import { fromBase64, toBase64 } from "./base64";

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

/** Sentinel prefix marking an `x-lunora-userid` value as base64url-encoded UTF-8. */
const USERID_ENCODED_PREFIX = "=";

/** Base64 (from {@link toBase64}) -> URL-safe, unpadded base64url. */
const toBase64Url = (bytes: Uint8Array): string => toBase64(bytes).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");

/** URL-safe base64url -> bytes, via {@link fromBase64} (which expects standard padded base64). */
const fromBase64Url = (value: string): Uint8Array => {
    const restored = value.replaceAll("-", "+").replaceAll("_", "/");
    const padded = restored + "=".repeat((4 - (restored.length % 4)) % 4);

    return fromBase64(padded);
};

/** `true` when every UTF-16 code unit of `value` is <= 255 (safe as a WebIDL `ByteString`). */
const isByteStringSafe = (value: string): boolean => {
    for (let index = 0; index < value.length; index += 1) {
        if (value.charCodeAt(index) > 255) {
            return false;
        }
    }

    return true;
};

/**
 * Encode identity claims for the `x-lunora-identity` header: UTF-8 JSON ->
 * base64url. The result is always ASCII, so it is always a valid header value
 * regardless of what `claims` contains.
 */
const encodeIdentityHeader = (claims: Record<string, unknown>): string => toBase64Url(textEncoder.encode(JSON.stringify(claims)));

/**
 * Decode an `x-lunora-identity` header value. `null`/empty -> `undefined`.
 * Sniffs legacy unencoded values (`raw[0] === "{"`) and parses them as JSON
 * directly; otherwise base64url-decodes -> UTF-8 -> `JSON.parse`s. Any
 * failure, or a successfully parsed non-object (array/primitive), -> `undefined`
 * — fail-soft, matching `parseIdentityHeader`'s pre-existing behavior.
 */
const decodeIdentityHeader = (raw: null | string | undefined): Record<string, unknown> | undefined => {
    if (!raw) {
        return undefined;
    }

    try {
        const json = raw[0] === "{" ? raw : textDecoder.decode(fromBase64Url(raw));
        const parsed = JSON.parse(json) as unknown;

        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            return parsed as Record<string, unknown>;
        }
    } catch {
        // fall through to undefined
    }

    return undefined;
};

/**
 * Encode a userId for the `x-lunora-userid` header. Returned unchanged when
 * every code unit is <= 255 (WebIDL `ByteString`-safe) AND it doesn't already
 * start with the `=` encoded-form sentinel; otherwise UTF-8-encoded,
 * base64url-encoded, and prefixed with `=`.
 */
const encodeUserIdHeader = (userId: string): string => {
    if (!userId.startsWith(USERID_ENCODED_PREFIX) && isByteStringSafe(userId)) {
        return userId;
    }

    return `${USERID_ENCODED_PREFIX}${toBase64Url(textEncoder.encode(userId))}`;
};

/**
 * Decode an `x-lunora-userid` header value produced by {@link encodeUserIdHeader}.
 * `null`/empty -> `undefined`. A value without the leading `=` sentinel is
 * returned unchanged (the common, unencoded case); a value with it is
 * base64url-decoded -> UTF-8. A malformed encoded value -> `undefined`
 * (fail-soft, matching {@link decodeIdentityHeader}).
 */
const decodeUserIdHeader = (raw: null | string | undefined): string | undefined => {
    if (!raw) {
        return undefined;
    }

    if (!raw.startsWith(USERID_ENCODED_PREFIX)) {
        return raw;
    }

    try {
        return textDecoder.decode(fromBase64Url(raw.slice(USERID_ENCODED_PREFIX.length)));
    } catch {
        return undefined;
    }
};

export { decodeIdentityHeader, decodeUserIdHeader, encodeIdentityHeader, encodeUserIdHeader };

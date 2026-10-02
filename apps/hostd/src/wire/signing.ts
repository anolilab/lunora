/**
 * Signing INPUTS for box identity (plan 458 D4) and signed release fetches
 * (D6). These helpers only build the exact bytes to sign; the signature
 * itself is the caller's job.
 *
 * Algorithm, for both: Ed25519 (RFC 8032, pure, no pre-hash) over the returned
 * bytes with the box's private key, sent as base64url without padding (an
 * 86-character string). With WebCrypto, which both Node and workerd provide:
 *
 * ```ts
 * const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", privateKey, challengeSigningPayload(nonce, boxId)));
 * const ok = await crypto.subtle.verify("Ed25519", publicKey, signatureBytes, challengeSigningPayload(nonce, boxId));
 * ```
 *
 * Each payload starts with its own domain tag, so a signature made for one
 * purpose can never be replayed as the other.
 */
import { InvalidField, readBoxId, readNonce } from "./validate";

/** Domain tag of the WebSocket challenge payload. */
const HOSTD_AUTH_DOMAIN = "lunora-hostd-auth:v1";

/** Domain tag of the signed-HTTP-request payload. */
const HOSTD_REQUEST_DOMAIN = "lunora-hostd-request:v1";

/** Header names that carry a signed HTTP request from a box (D6). */
const HOSTD_REQUEST_HEADERS = {
    boxId: "x-lunora-box-id",
    nonce: "x-lunora-box-nonce",
    signature: "x-lunora-box-signature",
    timestamp: "x-lunora-box-timestamp",
} as const;

const utf8 = new TextEncoder();

const METHOD_PATTERN = /^[A-Z]{1,16}$/u;

const MAX_PATH_LENGTH = 2048;

/** Space (0x20) and below are controls or whitespace; above `~` (0x7E) is DEL or not ASCII; 0x23 is `#`. */
const isPathCharacter = (code: number): boolean => code > 0x20 && code <= 0x7e && code !== 0x23;

/** An origin-form request target: `/`, then printable ASCII without spaces or `#`, at most 2048 characters. */
const isOriginFormPath = (path: string): boolean => {
    if (!path.startsWith("/") || path.length > MAX_PATH_LENGTH) {
        return false;
    }

    // Every allowed character is ASCII, so walking UTF-16 code units is exact:
    // any surrogate half is above 0x7E and rejected.
    for (let index = 0; index < path.length; index += 1) {
        if (!isPathCharacter(path.codePointAt(index) ?? 0)) {
            return false;
        }
    }

    return true;
};

/** Re-throws a validator failure as the `TypeError` these helpers document. */
const check = <T>(read: () => T): T => {
    try {
        return read();
    } catch (error: unknown) {
        if (error instanceof InvalidField) {
            throw new TypeError(error.message, { cause: error });
        }

        throw error;
    }
};

/**
 * The bytes a box signs to answer a `challenge`: the UTF-8 encoding of
 * `lunora-hostd-auth:v1:{boxId}:{nonce}`.
 *
 * `:` is an unambiguous separator because neither a box id nor a base64url
 * nonce can contain one; both are validated here.
 * @throws {TypeError} when `nonce` is not a 22-128 character base64url string or `boxId` is not a valid id.
 */
const challengeSigningPayload = (nonce: string, boxId: string): Uint8Array => {
    const checkedBoxId = check(() => readBoxId(boxId, "boxId"));
    const checkedNonce = check(() => readNonce(nonce, "nonce"));

    return utf8.encode(`${HOSTD_AUTH_DOMAIN}:${checkedBoxId}:${checkedNonce}`);
};

/** The parts of a signed HTTP request from a box. */
interface RequestSigningInput {
    /** The box making the request. */
    boxId: string;
    /** Upper-case HTTP method, e.g. `GET`. */
    method: string;
    /** Single use, 22-128 base64url characters; the server refuses a nonce it has seen. */
    nonce: string;
    /** Origin-form request target: path plus query, no fragment, e.g. `/v1/boxes/releases/dep_123`. */
    path: string;
    /** Unix epoch milliseconds. Optional: it bounds the server's replay window, but a skewed clock must not lock a box out. */
    timestamp?: number;
}

/**
 * The bytes a box signs for an HTTP request to the control plane: the UTF-8
 * encoding of these lines joined by `\n`, with no trailing newline:
 *
 * ```text
 * lunora-hostd-request:v1
 * {method}
 * {path}
 * {boxId}
 * {timestamp in decimal, or the empty string}
 * {nonce}
 * ```
 *
 * Newline separates the fields because a path may contain `:`; no field may
 * contain a newline, and all are validated here.
 * @throws {TypeError} when any field is malformed.
 */
const requestSigningPayload = (input: RequestSigningInput): Uint8Array => {
    if (!METHOD_PATTERN.test(input.method)) {
        throw new TypeError("method must be an upper-case HTTP method");
    }

    if (!isOriginFormPath(input.path)) {
        throw new TypeError("path must be an origin-form request target: '/' then printable ASCII, no '#', at most 2048 characters");
    }

    if (input.timestamp !== undefined && (!Number.isSafeInteger(input.timestamp) || input.timestamp < 0)) {
        throw new TypeError("timestamp must be a non-negative integer of Unix epoch milliseconds");
    }

    const boxId = check(() => readBoxId(input.boxId, "boxId"));
    const nonce = check(() => readNonce(input.nonce, "nonce"));
    const timestamp = input.timestamp === undefined ? "" : String(input.timestamp);

    return utf8.encode([HOSTD_REQUEST_DOMAIN, input.method, input.path, boxId, timestamp, nonce].join("\n"));
};

export type { RequestSigningInput };
export { challengeSigningPayload, HOSTD_AUTH_DOMAIN, HOSTD_REQUEST_DOMAIN, HOSTD_REQUEST_HEADERS, requestSigningPayload };

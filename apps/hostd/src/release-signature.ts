/**
 * Verifying a signed release envelope against the pinned release keys (plan
 * 458 W7, `protocol/hostd/README.md` §8.3), on WebCrypto — so the one
 * implementation runs in a box's Node and in the control plane's workerd.
 *
 * In order: the envelope must validate strictly; its `keyId` must name a key in
 * the trusted set (never a key the envelope brings); that key must not be a
 * placeholder, must be Ed25519, and must be filed under the id derived from it;
 * and the signature must verify over `releaseSigningPayload(manifest)`.
 */
import type { HostdReleaseEnvelope } from "./release-manifest";
import { releaseSigningPayload, validateReleaseEnvelope } from "./release-manifest";
import { HOSTD_RELEASE_KEY_PLACEHOLDER } from "./trusted-release-keys";

/** A trusted release key: an SPKI PEM string, or the raw 32-byte Ed25519 public key. */
type TrustedReleaseKey = string | Uint8Array;

/** Why a signed manifest was refused. */
type ReleaseVerifyErrorCode = "BAD_SIGNATURE" | "INVALID_ENVELOPE" | "INVALID_TRUSTED_KEY" | "PLACEHOLDER_KEY" | "UNKNOWN_KEY";

interface ReleaseVerifyError {
    code: ReleaseVerifyErrorCode;
    message: string;
    /** The offending field, for `INVALID_ENVELOPE`. */
    path?: string;
}

/** Outcome of {@link verifyReleaseManifest}. Verification never rejects. */
type ReleaseVerifyResult = { envelope: HostdReleaseEnvelope; ok: true } | { error: ReleaseVerifyError; ok: false };

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Uint8Array.from([0x30, 0x2a, 0x30, 0x05, 0x06, 0x03, 0x2b, 0x65, 0x70, 0x03, 0x21, 0x00]);

const ED25519_KEY_BYTES = 32;

const ED25519_SIGNATURE_BYTES = 64;

const PEM_PATTERN = /^\s*-----BEGIN PUBLIC KEY-----(?<body>[\s\w+/=]+)-----END PUBLIC KEY-----\s*$/u;

const refuse = (code: ReleaseVerifyErrorCode, message: string, path?: string): { error: ReleaseVerifyError; ok: false } => {
    return { error: path === undefined ? { code, message } : { code, message, path }, ok: false };
};

/** Standard base64 (`+/`, padding optional) or base64url → bytes; `undefined` when it is neither. */
const decodeBase64 = (text: string): Uint8Array<ArrayBuffer> | undefined => {
    const standard = text.replaceAll("-", "+").replaceAll("_", "/").replaceAll(/\s/gu, "");

    try {
        return Uint8Array.from(atob(standard.padEnd(Math.ceil(standard.length / 4) * 4, "=")), (character) => character.codePointAt(0) ?? 0);
    } catch {
        return undefined;
    }
};

/** The raw 32 bytes of a trusted key, or why it is not an Ed25519 public key. */
const rawKeyOf = (key: TrustedReleaseKey): { raw: Uint8Array<ArrayBuffer> } | { reason: string } => {
    if (key instanceof Uint8Array) {
        return key.byteLength === ED25519_KEY_BYTES
            ? { raw: Uint8Array.from(key) }
            : { reason: `a raw Ed25519 public key is ${String(ED25519_KEY_BYTES)} bytes, not ${String(key.byteLength)}` };
    }

    const body = PEM_PATTERN.exec(key)?.groups?.["body"];
    const der = body === undefined ? undefined : decodeBase64(body);

    if (der === undefined) {
        return { reason: "not an SPKI PEM public key" };
    }

    const isEd25519 = der.byteLength === ED25519_SPKI_PREFIX.byteLength + ED25519_KEY_BYTES && ED25519_SPKI_PREFIX.every((byte, index) => der[index] === byte);

    return isEd25519 ? { raw: der.slice(ED25519_SPKI_PREFIX.byteLength) } : { reason: "release keys are Ed25519, and this SPKI holds another key type" };
};

/** `ed25519-` and the first 16 lowercase hex digits of SHA-256 over the raw key — the id a key is published under. */
const keyIdOf = async (raw: Uint8Array<ArrayBuffer>): Promise<string> => {
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", raw));

    return `ed25519-${[...digest.subarray(0, 8)].map((byte) => byte.toString(16).padStart(2, "0")).join("")}`;
};

/**
 * Verifies a signed release envelope against a set of trusted keys, with
 * WebCrypto (`globalThis.crypto.subtle`), so it runs unchanged in Node and in
 * workerd.
 * @param envelope untrusted input, e.g. `JSON.parse` of a downloaded `manifest.json`
 * @param trustedKeys `{ [keyId]: SPKI PEM | raw 32-byte key }`, normally `HOSTD_TRUSTED_RELEASE_KEYS`
 * @returns the validated envelope, or why it was refused
 */
const verifyReleaseManifest = async (envelope: unknown, trustedKeys: Readonly<Record<string, TrustedReleaseKey>>): Promise<ReleaseVerifyResult> => {
    const validated = validateReleaseEnvelope(envelope);

    if (!validated.ok) {
        return refuse("INVALID_ENVELOPE", validated.error.message, validated.error.path);
    }

    const { keyId, manifest, signature } = validated.value;

    if (!Object.hasOwn(trustedKeys, keyId)) {
        return refuse("UNKNOWN_KEY", `release key ${JSON.stringify(keyId)} is not trusted`);
    }

    const trusted = trustedKeys[keyId] as TrustedReleaseKey;

    if (typeof trusted === "string" && trusted.includes(HOSTD_RELEASE_KEY_PLACEHOLDER)) {
        return refuse("PLACEHOLDER_KEY", `release key ${JSON.stringify(keyId)} is a placeholder, not a key; no release can verify against it`);
    }

    const parsed = rawKeyOf(trusted);

    if ("reason" in parsed) {
        return refuse("INVALID_TRUSTED_KEY", `trusted key ${JSON.stringify(keyId)} is not an Ed25519 public key: ${parsed.reason}`);
    }

    // The trusted-key map is keyed by the derived id; a key filed under the wrong
    // id would let one key answer for another's name.
    const derived = await keyIdOf(parsed.raw);

    if (derived !== keyId) {
        return refuse("INVALID_TRUSTED_KEY", `trusted key filed as ${JSON.stringify(keyId)} has key id ${derived}`);
    }

    const signatureBytes = decodeBase64(signature);

    if (signatureBytes?.byteLength !== ED25519_SIGNATURE_BYTES) {
        return refuse("BAD_SIGNATURE", "the release signature does not verify");
    }

    try {
        const key = await globalThis.crypto.subtle.importKey("raw", parsed.raw, { name: "Ed25519" }, false, ["verify"]);
        const verified = await globalThis.crypto.subtle.verify({ name: "Ed25519" }, key, signatureBytes, Uint8Array.from(releaseSigningPayload(manifest)));

        return verified ? { envelope: validated.value, ok: true } : refuse("BAD_SIGNATURE", "the release signature does not verify");
    } catch (error: unknown) {
        return refuse("INVALID_TRUSTED_KEY", `trusted key ${JSON.stringify(keyId)} could not be imported: ${(error as Error).message}`);
    }
};

export type { ReleaseVerifyError, ReleaseVerifyErrorCode, ReleaseVerifyResult, TrustedReleaseKey };
export { verifyReleaseManifest };

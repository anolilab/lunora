/**
 * `@lunora/hostd/release/verify` — signs `hostd` release manifests and checks
 * downloaded artifacts against them (plan 458 W7, §9 Q2).
 *
 * Node only: it uses `node:crypto` (Ed25519, SHA-256) and `node:fs`, nothing
 * else. Verifying a signed envelope runs on WebCrypto and lives in
 * `@lunora/hostd/release`, with the manifest types, validator and canonical
 * bytes, so workerd and Node share one implementation.
 */
import type { KeyObject } from "node:crypto";
import { createHash, createPrivateKey, createPublicKey, sign } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";

import type { HostdReleaseEnvelope, HostdReleaseManifest } from "./release-manifest";
import { releaseSigningPayload, validateReleaseManifest } from "./release-manifest";
import type { TrustedReleaseKey } from "./release-signature";

/** Why a downloaded artifact was refused. */
type ArtifactVerifyErrorCode = "HASH_MISMATCH" | "INVALID_EXPECTATION" | "READ_FAILED" | "SIZE_MISMATCH";

/** Outcome of {@link verifyArtifact}. Never rejects. */
type ArtifactVerifyResult = { error: { code: ArtifactVerifyErrorCode; message: string }; ok: false } | { ok: true };

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX = Buffer.from("302a300506032b6570032100", "hex");

const ED25519_KEY_BYTES = 32;

const SHA256_PATTERN = /^[\da-f]{64}$/u;

/** Parses a trusted key into an Ed25519 public `KeyObject`; throws when it is not one. */
const toPublicKey = (key: KeyObject | TrustedReleaseKey): KeyObject => {
    let parsed: KeyObject;

    if (typeof key === "string") {
        parsed = createPublicKey(key);
    } else if (key instanceof Uint8Array) {
        if (key.byteLength !== ED25519_KEY_BYTES) {
            throw new TypeError(`a raw Ed25519 public key is ${String(ED25519_KEY_BYTES)} bytes, not ${String(key.byteLength)}`);
        }

        parsed = createPublicKey({ format: "der", key: Buffer.concat([ED25519_SPKI_PREFIX, key]), type: "spki" });
    } else {
        parsed = key.type === "private" ? createPublicKey(key) : key;
    }

    if (parsed.asymmetricKeyType !== "ed25519") {
        throw new TypeError(`release keys are Ed25519, not ${String(parsed.asymmetricKeyType)}`);
    }

    return parsed;
};

/** The raw 32 bytes of an Ed25519 public key. */
const rawPublicKey = (key: KeyObject): Buffer => key.export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX.byteLength);

/**
 * The key id a release key is published under: `ed25519-` and the first 16
 * lowercase hex digits of SHA-256 over the raw 32-byte public key. Derived,
 * never chosen, so the id in an envelope cannot drift from the key that signed it.
 * @throws {TypeError} when `key` is not an Ed25519 key.
 */
const releaseKeyId = (key: KeyObject | TrustedReleaseKey): string =>
    `ed25519-${createHash("sha256")
        .update(rawPublicKey(toPublicKey(key)))
        .digest("hex")
        .slice(0, 16)}`;

/**
 * Signs a manifest with an Ed25519 private key (PKCS#8 PEM or a `KeyObject`).
 * @returns the envelope to publish as `manifest.json`
 * @throws {TypeError} when the manifest is invalid or the key is not an Ed25519 private key.
 */
const signReleaseManifest = (manifest: HostdReleaseManifest, privateKey: KeyObject | string): HostdReleaseEnvelope => {
    const key = typeof privateKey === "string" ? createPrivateKey(privateKey) : privateKey;

    if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") {
        throw new TypeError("the release signing key must be an Ed25519 private key");
    }

    const checked = validateReleaseManifest(manifest);

    if (!checked.ok) {
        throw new TypeError(`invalid release manifest: ${checked.error.message}`);
    }

    return {
        keyId: releaseKeyId(key),
        manifest: checked.value,
        signature: sign(undefined, releaseSigningPayload(checked.value), key).toString("base64url"),
    };
};

const hashFile = async (filePath: string): Promise<string> => {
    const hash = createHash("sha256");

    for await (const chunk of createReadStream(filePath)) {
        hash.update(chunk as Buffer);
    }

    return hash.digest("hex");
};

/**
 * Checks a downloaded artifact against the size and SHA-256 its manifest pins.
 * The size is checked first, so a truncated or padded download fails without
 * being hashed.
 * @param source a file path, or the bytes themselves
 */
const verifyArtifact = async (source: string | Uint8Array, expectedSha256: string, expectedSize: number): Promise<ArtifactVerifyResult> => {
    if (!SHA256_PATTERN.test(expectedSha256) || !Number.isSafeInteger(expectedSize) || expectedSize < 0) {
        return { error: { code: "INVALID_EXPECTATION", message: "expected a lowercase hex SHA-256 and a non-negative integer size" }, ok: false };
    }

    let size: number;
    let digest: string;

    try {
        if (typeof source === "string") {
            const stats = await stat(source);

            size = stats.size;

            if (size !== expectedSize) {
                return { error: { code: "SIZE_MISMATCH", message: `expected ${String(expectedSize)} bytes, found ${String(size)}` }, ok: false };
            }

            digest = await hashFile(source);
        } else {
            size = source.byteLength;

            if (size !== expectedSize) {
                return { error: { code: "SIZE_MISMATCH", message: `expected ${String(expectedSize)} bytes, found ${String(size)}` }, ok: false };
            }

            digest = createHash("sha256").update(source).digest("hex");
        }
    } catch (error: unknown) {
        return { error: { code: "READ_FAILED", message: (error as Error).message }, ok: false };
    }

    if (digest !== expectedSha256) {
        return { error: { code: "HASH_MISMATCH", message: `expected sha256 ${expectedSha256}, found ${digest}` }, ok: false };
    }

    return { ok: true };
};

export type { ArtifactVerifyErrorCode, ArtifactVerifyResult };
export { releaseKeyId, signReleaseManifest, verifyArtifact };

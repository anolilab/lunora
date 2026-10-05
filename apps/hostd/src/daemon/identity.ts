/**
 * The box's identity (plan 458 D4): an Ed25519 key pair generated on the box
 * at enrolment. The control plane stores only the raw public key, base64url
 * without padding (43 characters); the private key never leaves this file.
 */
import type { KeyObject } from "node:crypto";
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

import { isOpenToOthers, permissionsOf, writeFileAtomic } from "./config";

/** DER prefix of an Ed25519 SubjectPublicKeyInfo (RFC 8410); the 32 raw key bytes follow it. */
const ED25519_SPKI_PREFIX_LENGTH = 12;

interface BoxIdentity {
    /** The raw public key, base64url without padding — what `POST /v1/boxes/enrol` registers. */
    publicKey: string;
    /** Sign `payload` (pure Ed25519); the signature as base64url without padding, 86 characters. */
    sign: (payload: Uint8Array) => string;
}

const identityOf = (privateKey: KeyObject): BoxIdentity => {
    if (privateKey.asymmetricKeyType !== "ed25519") {
        throw new TypeError(`the box key must be Ed25519, not ${String(privateKey.asymmetricKeyType)}`);
    }

    const publicKey = createPublicKey(privateKey).export({ format: "der", type: "spki" }).subarray(ED25519_SPKI_PREFIX_LENGTH).toString("base64url");

    return {
        publicKey,
        sign: (payload) => sign(undefined, payload, privateKey).toString("base64url"),
    };
};

/** Generate a fresh key pair and write the private key to `path` (PKCS#8 PEM, mode 0600). */
const generateIdentity = (path: string): BoxIdentity => {
    const { privateKey } = generateKeyPairSync("ed25519");

    writeFileAtomic(path, privateKey.export({ format: "pem", type: "pkcs8" }), 0o600);

    return identityOf(privateKey);
};

/**
 * Load the box's key from `path`.
 * @throws {Error} when the file is missing, readable by others, or not an Ed25519 private key.
 */
const loadIdentity = (path: string): BoxIdentity => {
    const { mode } = statSync(path);

    if (isOpenToOthers(mode)) {
        throw new Error(`${path} is readable by others (mode ${permissionsOf(mode).toString(8)}); chmod 600 it`);
    }

    return identityOf(createPrivateKey(readFileSync(path, "utf8")));
};

export type { BoxIdentity };
export { generateIdentity, loadIdentity };

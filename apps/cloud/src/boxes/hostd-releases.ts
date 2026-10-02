/**
 * Signed `lunora-hostd` releases on the control plane (plan 458 W7, G17).
 *
 * A release is accepted only as its signed envelope (`manifest.json`,
 * `protocol/hostd/README.md` §8), checked exactly as a box checks it (§8.3):
 * strict validation by `@lunora/hostd/release`, the key looked up in the SAME
 * pinned set the `hostd` binary ships (`HOSTD_TRUSTED_RELEASE_KEYS` — never a key
 * from the envelope), a placeholder entry refused, and the Ed25519 signature
 * verified over the canonical bytes. `@lunora/hostd/release/verify` does this
 * with `node:crypto`; the Worker has WebCrypto, so the signature check is here.
 */
import type { HostdReleaseEnvelope } from "@lunora/hostd/release";
import { HOSTD_RELEASE_KEY_PLACEHOLDER, HOSTD_TRUSTED_RELEASE_KEYS, releaseSigningPayload, validateReleaseEnvelope } from "@lunora/hostd/release";

import { fromBase64Url } from "./encoding";

/** What verifying an untrusted envelope found. */
export type ReleaseVerification = { envelope: HostdReleaseEnvelope; ok: true } | { ok: false; reason: string };

const PEM_BODY = /-----BEGIN PUBLIC KEY-----(?<body>[\s\w+/=]+)-----END PUBLIC KEY-----/u;

/** The DER of an SPKI PEM, or `null` when it is not one. */
const pemToDer = (pem: string): null | Uint8Array<ArrayBuffer> => {
    const body = PEM_BODY.exec(pem)?.groups?.["body"]?.replaceAll(/\s/gu, "");

    try {
        return body ? Uint8Array.from(atob(body), (character) => character.codePointAt(0) ?? 0) : null;
    } catch {
        return null;
    }
};

/**
 * Verify an untrusted release envelope against the pinned release keys. Never
 * throws.
 * @param value the envelope, as parsed from untrusted JSON
 * @param trustedKeys keyId → SPKI PEM; the pinned set unless a test hands in its own
 */
export const verifyReleaseEnvelope = async (
    value: unknown,
    trustedKeys: Readonly<Record<string, string>> = HOSTD_TRUSTED_RELEASE_KEYS,
): Promise<ReleaseVerification> => {
    const validated = validateReleaseEnvelope(value);

    if (!validated.ok) {
        return { ok: false, reason: `invalid release envelope at ${validated.error.path}: ${validated.error.message}` };
    }

    const envelope = validated.value;
    const pem = Object.hasOwn(trustedKeys, envelope.keyId) ? trustedKeys[envelope.keyId] : undefined;

    if (pem === undefined) {
        return { ok: false, reason: `release key "${envelope.keyId}" is not one this control plane trusts` };
    }

    if (pem.includes(HOSTD_RELEASE_KEY_PLACEHOLDER)) {
        return { ok: false, reason: `release key "${envelope.keyId}" is a placeholder, not a key; no release can be accepted until a real key is pinned` };
    }

    const der = pemToDer(pem);
    const signature = fromBase64Url(envelope.signature);

    if (der === null) {
        return { ok: false, reason: `trusted release key "${envelope.keyId}" is not an SPKI PEM` };
    }

    try {
        const key = await crypto.subtle.importKey("spki", der, { name: "Ed25519" }, false, ["verify"]);
        const verified =
            signature !== null && (await crypto.subtle.verify({ name: "Ed25519" }, key, signature, Uint8Array.from(releaseSigningPayload(envelope.manifest))));

        return verified ? { envelope, ok: true } : { ok: false, reason: "the release signature does not verify" };
    } catch {
        return { ok: false, reason: `trusted release key "${envelope.keyId}" is not an Ed25519 key` };
    }
};

/** The three versions a release installs — what a box's `hello` reports, compared as a whole. */
export interface ReleaseVersions {
    caddy: string;
    celld: string;
    hostd: string;
}

export const versionsOf = (envelope: HostdReleaseEnvelope): ReleaseVersions => {
    return { caddy: envelope.manifest.caddy.version, celld: envelope.manifest.celld.version, hostd: envelope.manifest.hostd.version };
};

/** One string per version set, so a fleet-upgrade plan can compare a box to a release. */
export const versionKey = (versions: ReleaseVersions): string => `hostd ${versions.hostd} / celld ${versions.celld} / caddy ${versions.caddy}`;

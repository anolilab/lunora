import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { HostdReleaseEnvelope, HostdReleaseManifest } from "../src/release";
import {
    canonicalManifestBytes,
    HOSTD_RELEASE_KEY_PLACEHOLDER,
    HOSTD_TRUSTED_RELEASE_KEYS,
    releaseSigningPayload,
    validateReleaseEnvelope,
    validateReleaseManifest,
} from "../src/release";
import { releaseKeyId, signReleaseManifest, verifyArtifact, verifyReleaseManifest } from "../src/release-verify";

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);

const artifact = (platform: "linux-arm64" | "linux-x64", component: string, sha256 = SHA_A) => {
    return { platform, sha256, size: 1024, url: `https://example.com/${component}-${platform}` };
};

const makeManifest = (): HostdReleaseManifest => {
    return {
        caddy: {
            artifacts: [artifact("linux-x64", "caddy"), artifact("linux-arm64", "caddy")],
            modules: ["github.com/mholt/caddy-ratelimit"],
            version: "v2.11.6",
        },
        celld: {
            artifacts: [
                { ...artifact("linux-x64", "celld"), compression: "gzip" },
                { ...artifact("linux-arm64", "celld"), compression: "gzip" },
            ],
            version: "v0.6.0",
        },
        createdAt: "2026-10-02T12:00:00.000Z",
        hostd: { artifacts: [artifact("linux-x64", "hostd", SHA_B), artifact("linux-arm64", "hostd", SHA_B)], version: "1.0.0" },
        releaseId: "hostd-v1_0_0",
        schema: 1,
    };
};

const keyPair = () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");

    return {
        privateKey,
        publicPem: publicKey.export({ format: "pem", type: "spki" }),
        publicRaw: new Uint8Array(publicKey.export({ format: "der", type: "spki" }).subarray(12)),
    };
};

const signed = () => {
    const keys = keyPair();
    const envelope = signReleaseManifest(makeManifest(), keys.privateKey);

    return { envelope, keys, trusted: { [envelope.keyId]: keys.publicPem } };
};

/** A deep, mutable copy of an envelope. */
const clone = (envelope: HostdReleaseEnvelope): HostdReleaseEnvelope => structuredClone(envelope);

describe(validateReleaseManifest, () => {
    it("accepts a valid manifest and returns a fresh copy", () => {
        const manifest = makeManifest();
        const result = validateReleaseManifest(manifest);

        expect(result).toStrictEqual({ ok: true, value: manifest });
        expect(result.ok && result.value).not.toBe(manifest);
    });

    it.each([
        ["an unknown top-level field", (m: Record<string, unknown>) => Object.assign(m, { extra: true }), "$.extra"],
        ["an unknown artifact field", (m: any) => Object.assign(m.hostd.artifacts[0], { mirror: "x" }), "$.hostd.artifacts[0].mirror"],
        ["another schema", (m: any) => Object.assign(m, { schema: 2 }), "$.schema"],
        ["an http URL", (m: any) => Object.assign(m.hostd.artifacts[0], { url: "http://example.com/x" }), "$.hostd.artifacts[0].url"],
        ["a URL with credentials", (m: any) => Object.assign(m.celld.artifacts[0], { url: "https://u:p@example.com/x" }), "$.celld.artifacts[0].url"],
        ["a URL needing a JSON escape", (m: any) => Object.assign(m.hostd.artifacts[0], { url: 'https://example.com/a"b' }), "$.hostd.artifacts[0].url"],
        ["a non-ASCII URL", (m: any) => Object.assign(m.hostd.artifacts[0], { url: "https://example.com/ü" }), "$.hostd.artifacts[0].url"],
        ["an uppercase sha256", (m: any) => Object.assign(m.hostd.artifacts[0], { sha256: "A".repeat(64) }), "$.hostd.artifacts[0].sha256"],
        ["a short sha256", (m: any) => Object.assign(m.hostd.artifacts[0], { sha256: "ab" }), "$.hostd.artifacts[0].sha256"],
        ["a zero size", (m: any) => Object.assign(m.hostd.artifacts[0], { size: 0 }), "$.hostd.artifacts[0].size"],
        ["an unknown platform", (m: any) => Object.assign(m.hostd.artifacts[0], { platform: "darwin-arm64" }), "$.hostd.artifacts[0].platform"],
        ["a repeated platform", (m: any) => Object.assign(m.hostd.artifacts[1], { platform: "linux-x64" }), "$.hostd.artifacts[1].platform"],
        ["a component missing a platform", (m: any) => m.caddy.artifacts.pop(), "$.caddy.artifacts"],
        ["no artifacts", (m: any) => Object.assign(m.hostd, { artifacts: [] }), "$.hostd.artifacts"],
        ["an unknown compression", (m: any) => Object.assign(m.celld.artifacts[0], { compression: "zstd" }), "$.celld.artifacts[0].compression"],
        ["a release id with a dot", (m: any) => Object.assign(m, { releaseId: "hostd-v1.0.0" }), "$.releaseId"],
        ["a bad version", (m: any) => Object.assign(m.hostd, { version: "1 0" }), "$.hostd.version"],
        ["an impossible date", (m: any) => Object.assign(m, { createdAt: "2026-13-45T00:00:00Z" }), "$.createdAt"],
        ["a module that is not a module path", (m: any) => Object.assign(m.caddy, { modules: ["caddy-ratelimit"] }), "$.caddy.modules[0]"],
        ["a repeated module", (m: any) => Object.assign(m.caddy, { modules: ["github.com/a/b", "github.com/a/b"] }), "$.caddy.modules"],
    ])("rejects %s", (_name, mutate, path) => {
        const manifest = makeManifest();

        mutate(manifest as unknown as Record<string, unknown>);

        const result = validateReleaseManifest(manifest);

        expect(result.ok).toBe(false);
        expect(!result.ok && result.error.path).toBe(path);
    });

    it.each([null, [], "manifest", 1])("rejects %j without throwing", (value) => {
        expect(validateReleaseManifest(value).ok).toBe(false);
    });
});

describe(validateReleaseEnvelope, () => {
    it("rejects an unknown envelope field and a malformed signature", () => {
        const { envelope } = signed();

        expect(validateReleaseEnvelope({ ...envelope, note: "x" })).toMatchObject({ error: { path: "$.note" }, ok: false });
        expect(validateReleaseEnvelope({ ...envelope, signature: "abc" })).toMatchObject({ error: { path: "$.signature" }, ok: false });
        expect(validateReleaseEnvelope({ ...envelope, keyId: "key id" })).toMatchObject({ error: { path: "$.keyId" }, ok: false });
    });
});

describe(canonicalManifestBytes, () => {
    it("sorts keys and drops whitespace", () => {
        const text = new TextDecoder().decode(canonicalManifestBytes(makeManifest()));

        expect(text.startsWith('{"caddy":{"artifacts":[{"platform":"linux-x64","sha256":"')).toBe(true);
        expect(text).not.toMatch(/\s/u);
        expect(JSON.parse(text)).toStrictEqual(makeManifest());
    });

    it("does not depend on key order", () => {
        const manifest = makeManifest();
        const reordered = JSON.parse(
            JSON.stringify(manifest, (_key, value: unknown) => {
                if (typeof value === "object" && value !== null && !Array.isArray(value)) {
                    return Object.fromEntries(Object.entries(value).toReversed());
                }

                return value;
            }),
        ) as HostdReleaseManifest;

        expect(Object.keys(reordered)[0]).toBe("schema");
        expect(canonicalManifestBytes(reordered)).toStrictEqual(canonicalManifestBytes(manifest));
    });

    it("keeps array order, so reordering artifacts changes the bytes", () => {
        const manifest = makeManifest();

        manifest.hostd.artifacts.reverse();

        expect(canonicalManifestBytes(manifest)).not.toStrictEqual(canonicalManifestBytes(makeManifest()));
    });

    it("throws on an invalid manifest", () => {
        expect(() => canonicalManifestBytes({ ...makeManifest(), releaseId: "" })).toThrow(TypeError);
    });

    it("prefixes the signing payload with the domain tag", () => {
        const payload = new TextDecoder().decode(releaseSigningPayload(makeManifest()));

        expect(payload).toBe(`lunora-hostd-release:v1\n${new TextDecoder().decode(canonicalManifestBytes(makeManifest()))}`);
    });
});

describe(verifyReleaseManifest, () => {
    it("verifies a round trip through pretty-printed JSON with a PEM key", () => {
        const { envelope, trusted } = signed();

        expect(verifyReleaseManifest(JSON.parse(JSON.stringify(envelope, undefined, 4)), trusted)).toStrictEqual({ manifest: makeManifest(), ok: true });
    });

    it("verifies against a raw 32-byte key", () => {
        const { envelope, keys } = signed();

        expect(verifyReleaseManifest(envelope, { [envelope.keyId]: keys.publicRaw }).ok).toBe(true);
    });

    it("derives the key id from the public key", () => {
        const { envelope, keys } = signed();

        expect(envelope.keyId).toMatch(/^ed25519-[\da-f]{16}$/u);
        expect(releaseKeyId(keys.publicPem)).toBe(envelope.keyId);
        expect(releaseKeyId(keys.publicRaw)).toBe(envelope.keyId);
    });

    it("refuses a manifest changed after signing", () => {
        const { envelope, trusted } = signed();
        const tampered = clone(envelope);

        (tampered.manifest.hostd.artifacts[0] as { sha256: string }).sha256 = "c".repeat(64);

        expect(verifyReleaseManifest(tampered, trusted)).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });

    it("refuses a changed signature", () => {
        const { envelope, trusted } = signed();
        const tampered = clone(envelope);
        const bytes = Buffer.from(tampered.signature, "base64url");

        bytes[0] = ((bytes[0] ?? 0) + 1) % 256;
        tampered.signature = bytes.toString("base64url");

        expect(verifyReleaseManifest(tampered, trusted)).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });

    it("refuses a signature from another trusted key filed under the signer's id", () => {
        const { envelope } = signed();
        const other = keyPair();

        expect(verifyReleaseManifest(envelope, { [envelope.keyId]: other.publicPem })).toMatchObject({
            error: { code: "INVALID_TRUSTED_KEY" },
            ok: false,
        });
    });

    it("refuses a wrong key id", () => {
        const { envelope, trusted } = signed();
        const other = keyPair();
        const relabelled = { ...clone(envelope), keyId: releaseKeyId(other.publicPem) };

        expect(verifyReleaseManifest(relabelled, { ...trusted, [relabelled.keyId]: other.publicPem })).toMatchObject({
            error: { code: "BAD_SIGNATURE" },
            ok: false,
        });
    });

    it("refuses an unknown key", () => {
        const { envelope } = signed();

        expect(verifyReleaseManifest(envelope, {})).toMatchObject({ error: { code: "UNKNOWN_KEY" }, ok: false });
        expect(verifyReleaseManifest({ ...envelope, keyId: "toString" }, {})).toMatchObject({ error: { code: "UNKNOWN_KEY" }, ok: false });
    });

    it("refuses a placeholder key", () => {
        const { envelope } = signed();
        const result = verifyReleaseManifest({ ...envelope, keyId: "ed25519-placeholder" }, HOSTD_TRUSTED_RELEASE_KEYS);

        expect(result).toMatchObject({ error: { code: "PLACEHOLDER_KEY" }, ok: false });
    });

    it("ships only placeholder keys until a maintainer commits a real one", () => {
        for (const key of Object.values(HOSTD_TRUSTED_RELEASE_KEYS)) {
            expect(key).toContain(HOSTD_RELEASE_KEY_PLACEHOLDER);
        }
    });

    it("refuses a trusted key that is not Ed25519", () => {
        const { envelope } = signed();
        const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).publicKey.export({ format: "pem", type: "spki" });

        expect(verifyReleaseManifest(envelope, { [envelope.keyId]: rsa })).toMatchObject({ error: { code: "INVALID_TRUSTED_KEY" }, ok: false });
    });

    it("refuses an invalid envelope with its path", () => {
        const { envelope, trusted } = signed();
        const broken = clone(envelope);

        (broken.manifest as unknown as Record<string, unknown>).extra = 1;

        expect(verifyReleaseManifest(broken, trusted)).toStrictEqual({
            error: { code: "INVALID_ENVELOPE", message: "$.manifest.extra is not a known field", path: "$.manifest.extra" },
            ok: false,
        });
    });

    it("refuses to sign with a non-Ed25519 key or an invalid manifest", () => {
        const rsa = generateKeyPairSync("rsa", { modulusLength: 1024 }).privateKey;

        expect(() => signReleaseManifest(makeManifest(), rsa)).toThrow(TypeError);
        expect(() => signReleaseManifest({ ...makeManifest(), releaseId: "a.b" }, keyPair().privateKey)).toThrow(TypeError);
    });
});

describe(verifyArtifact, () => {
    const directory = mkdtempSync(join(tmpdir(), "hostd-release-"));
    const file = join(directory, "artifact");
    const bytes = new TextEncoder().encode("lunora-hostd");
    // `printf 'lunora-hostd' | sha256sum`
    const sha256 = "a360d5901eab9ea3ca9b916c304d8b5351cc64a2a0cd451ea851b4c5295460cb";

    beforeAll(() => {
        writeFileSync(file, bytes);
    });

    afterAll(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("accepts matching bytes and files", async () => {
        await expect(verifyArtifact(bytes, sha256, bytes.byteLength)).resolves.toStrictEqual({ ok: true });
        await expect(verifyArtifact(file, sha256, bytes.byteLength)).resolves.toStrictEqual({ ok: true });
    });

    it("refuses a size mismatch before hashing", async () => {
        await expect(verifyArtifact(file, SHA_A, bytes.byteLength + 1)).resolves.toMatchObject({ error: { code: "SIZE_MISMATCH" }, ok: false });
        await expect(verifyArtifact(bytes, SHA_A, 1)).resolves.toMatchObject({ error: { code: "SIZE_MISMATCH" }, ok: false });
    });

    it("refuses a hash mismatch", async () => {
        await expect(verifyArtifact(file, SHA_A, bytes.byteLength)).resolves.toMatchObject({ error: { code: "HASH_MISMATCH" }, ok: false });
        await expect(verifyArtifact(bytes, SHA_A, bytes.byteLength)).resolves.toMatchObject({ error: { code: "HASH_MISMATCH" }, ok: false });
    });

    it("refuses a missing file and a malformed expectation", async () => {
        await expect(verifyArtifact(join(directory, "missing"), SHA_A, 1)).resolves.toMatchObject({ error: { code: "READ_FAILED" }, ok: false });
        await expect(verifyArtifact(bytes, "ABC", 1)).resolves.toMatchObject({ error: { code: "INVALID_EXPECTATION" }, ok: false });
    });
});

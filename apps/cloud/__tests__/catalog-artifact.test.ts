import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import { CATALOG_FORMAT, verifyArtifact } from "../src/catalog/artifact";
import { manifestMatchesIndex, verifyCatalogIndex } from "../src/catalog/index";
import type { TrustedCatalogKey } from "../src/catalog/signature";
import { ARTIFACT_SIGNING_DOMAIN, decodeBase64, INDEX_SIGNING_DOMAIN, sha256Hex } from "../src/catalog/signature";
import okOf from "./catalog-helpers";

const encoder = new TextEncoder();

/** A fresh Ed25519 catalog key: the trusted public half and the signing half. */
const makeKey = async (keyId: string) => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return { keyId, privateKey: pair.privateKey, trusted: { keyId, publicKey } satisfies TrustedCatalogKey };
};

type Key = Awaited<ReturnType<typeof makeKey>>;

/** Sign `payload` under `domain` the way the catalog's CI does, and return the base64 signature. */
const sign = async (key: Key, domain: string, payload: Uint8Array): Promise<string> => {
    const tag = encoder.encode(`${domain}\n`);
    const signed = new Uint8Array(tag.byteLength + payload.byteLength);

    signed.set(tag, 0);
    signed.set(payload, tag.byteLength);

    const signature = new Uint8Array(await crypto.subtle.sign("Ed25519", key.privateKey, signed));

    return btoa(String.fromCodePoint(...signature));
};

const workerSource = encoder.encode('export default { fetch: () => new Response("ok") };');
const assetBytes = encoder.encode("body { color: black }");

/**
 * Build a signed artifact over `files`. The manifest lists each file by its real
 * hash and size; a test overrides `manifestOver` or the archive to break one thing.
 */
const makeArtifact = async (
    key: Key,
    options: {
        archiveFiles?: Record<string, Uint8Array>;
        files?: Record<string, Uint8Array>;
        manifestOver?: Record<string, unknown>;
    } = {},
) => {
    const files = options.files ?? { "worker.js": workerSource, "assets/app.css": assetBytes };
    const listed = await Promise.all(
        Object.entries(files).map(async ([path, bytes]) => {
            return { path, sha256: await sha256Hex(bytes), size: bytes.byteLength };
        }),
    );
    const manifest = {
        files: listed,
        format: CATALOG_FORMAT,
        main: "worker.js",
        slug: "counter",
        version: "1.2.0",
        ...options.manifestOver,
    };
    const manifestBytes = encoder.encode(JSON.stringify(manifest));
    const archive = zipSync(options.archiveFiles ?? files);

    return {
        archive,
        manifestBytes,
        signature: { keyId: key.keyId, signature: await sign(key, ARTIFACT_SIGNING_DOMAIN, manifestBytes) },
    };
};

describe(verifyArtifact, () => {
    it("verifies a signed artifact and returns each listed file", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key);

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        const verified = okOf(result);

        expect(verified.manifest.main).toBe("worker.js");
        expect(new TextDecoder().decode(verified.files.get("worker.js"))).toContain("export default");
        expect(verified.files.size).toBe(2);
    });

    it("refuses a signature from a key the control plane does not trust", async () => {
        const trusted = await makeKey("k1");
        const stranger = await makeKey("k1");
        const artifact = await makeArtifact(stranger);

        const result = await verifyArtifact({ ...artifact, keys: [trusted.trusted] });

        expect(result).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });

    it("refuses a signature that names a key it does not have", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key);

        const result = await verifyArtifact({ ...artifact, keys: [] });

        expect(result).toMatchObject({ error: { code: "UNKNOWN_KEY" }, ok: false });
    });

    it("refuses an index signature replayed as an artifact signature", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key);
        const replayed = await sign(key, INDEX_SIGNING_DOMAIN, artifact.manifestBytes);

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted], signature: { keyId: "k1", signature: replayed } });

        expect(result).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });

    it("refuses a manifest changed after it was signed", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key);
        const tampered = encoder.encode(new TextDecoder().decode(artifact.manifestBytes).replace("1.2.0", "9.9.9"));

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted], manifestBytes: tampered });

        expect(result).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });

    it("refuses an archive whose file bytes differ from the signed hash, even at the same size", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key, {
            archiveFiles: { "worker.js": encoder.encode('export default { fetch: () => new Response("no") };'), "assets/app.css": assetBytes },
        });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "HASH_MISMATCH" }, ok: false });
    });

    it("refuses an archive that holds a file the manifest does not list", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key, {
            archiveFiles: { "worker.js": workerSource, "assets/app.css": assetBytes, "secrets.env": encoder.encode("X=1") },
        });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "UNLISTED_FILE" }, ok: false });
    });

    it("refuses an archive missing a listed file", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key, { archiveFiles: { "worker.js": workerSource } });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "MISSING_FILE" }, ok: false });
    });

    it("refuses a file whose declared size is wrong", async () => {
        const key = await makeKey("k1");
        const listed = [
            { path: "worker.js", sha256: await sha256Hex(workerSource), size: workerSource.byteLength + 1 },
            { path: "assets/app.css", sha256: await sha256Hex(assetBytes), size: assetBytes.byteLength },
        ];
        const artifact = await makeArtifact(key, { manifestOver: { files: listed } });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "SIZE_MISMATCH" }, ok: false });
    });

    it("refuses a manifest format this control plane does not read", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key, { manifestOver: { format: 2 } });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "UNSUPPORTED_FORMAT" }, ok: false });
    });

    it("refuses an unknown manifest field rather than dropping it", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key, { manifestOver: { lables: ["typo"] } });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "INVALID_MANIFEST" }, ok: false });
    });

    it("refuses a path that climbs out of the archive", async () => {
        const key = await makeKey("k1");
        const files = { "../escape.js": workerSource };
        const artifact = await makeArtifact(key, { files, manifestOver: { main: "../escape.js" } });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "INVALID_MANIFEST" }, ok: false });
    });

    it("refuses a main module the manifest does not list", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key, { manifestOver: { main: "index.js" } });

        const result = await verifyArtifact({ ...artifact, keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "INVALID_MANIFEST" }, ok: false });
    });

    it("refuses bytes that are not a zip", async () => {
        const key = await makeKey("k1");
        const artifact = await makeArtifact(key);

        const result = await verifyArtifact({ ...artifact, archive: encoder.encode("not a zip at all"), keys: [key.trusted] });

        expect(result).toMatchObject({ error: { code: "BAD_ARCHIVE" }, ok: false });
    });
});

/** The verifier's clock, and an index issued at that time. */
const NOW = Date.UTC(2026, 9, 10);
const ISSUED = new Date(NOW).toISOString();

describe(verifyCatalogIndex, () => {
    const indexFor = (apps: unknown[], issuedAt: string = ISSUED) => encoder.encode(JSON.stringify({ apps, format: CATALOG_FORMAT, issuedAt }));

    it("verifies a signed index and lists each app's latest release", async () => {
        const key = await makeKey("k1");
        const indexBytes = indexFor([
            {
                artifactUrl: "https://catalog.example.com/counter-1.2.0.zip",
                manifestSha256: "a".repeat(64),
                manifestUrl: "https://catalog.example.com/counter-1.2.0.manifest.json",
                name: "Counter",
                signatureUrl: "https://catalog.example.com/counter-1.2.0.manifest.sig",
                slug: "counter",
                version: "1.2.0",
            },
        ]);

        const result = await verifyCatalogIndex({
            indexBytes,
            now: NOW,
            keys: [key.trusted],
            signature: { keyId: "k1", signature: await sign(key, INDEX_SIGNING_DOMAIN, indexBytes) },
        });

        expect(result).toMatchObject({ entries: [{ slug: "counter", version: "1.2.0" }], ok: true });
    });

    it("refuses an index signed under the artifact domain", async () => {
        const key = await makeKey("k1");
        const indexBytes = indexFor([]);

        const result = await verifyCatalogIndex({
            indexBytes,
            now: NOW,
            keys: [key.trusted],
            signature: { keyId: "k1", signature: await sign(key, ARTIFACT_SIGNING_DOMAIN, indexBytes) },
        });

        expect(result).toMatchObject({ error: { code: "BAD_SIGNATURE" }, ok: false });
    });

    it("refuses an artifact URL that is not https", async () => {
        const key = await makeKey("k1");
        const indexBytes = indexFor([{ artifactUrl: "http://catalog.example.com/x.zip", manifestSha256: "b".repeat(64), slug: "counter", version: "1.0.0" }]);

        const result = await verifyCatalogIndex({
            indexBytes,
            now: NOW,
            keys: [key.trusted],
            signature: { keyId: "k1", signature: await sign(key, INDEX_SIGNING_DOMAIN, indexBytes) },
        });

        expect(result).toMatchObject({ error: { code: "INVALID_INDEX" }, ok: false });
    });

    it("refuses an index older than the replay window", async () => {
        const key = await makeKey("k1");
        const indexBytes = indexFor([], new Date(NOW - 15 * 24 * 60 * 60 * 1000).toISOString());

        const result = await verifyCatalogIndex({
            indexBytes,
            keys: [key.trusted],
            now: NOW,
            signature: { keyId: "k1", signature: await sign(key, INDEX_SIGNING_DOMAIN, indexBytes) },
        });

        expect(result).toMatchObject({ error: { code: "INVALID_INDEX" }, ok: false });
    });

    it("refuses an index dated in the future", async () => {
        const key = await makeKey("k1");
        const indexBytes = indexFor([], new Date(NOW + 60 * 60 * 1000).toISOString());

        const result = await verifyCatalogIndex({
            indexBytes,
            keys: [key.trusted],
            now: NOW,
            signature: { keyId: "k1", signature: await sign(key, INDEX_SIGNING_DOMAIN, indexBytes) },
        });

        expect(result).toMatchObject({ error: { code: "INVALID_INDEX" }, ok: false });
    });

    it("refuses an index with no issuedAt", async () => {
        const key = await makeKey("k1");
        const indexBytes = encoder.encode(JSON.stringify({ apps: [], format: CATALOG_FORMAT }));

        const result = await verifyCatalogIndex({
            indexBytes,
            keys: [key.trusted],
            now: NOW,
            signature: { keyId: "k1", signature: await sign(key, INDEX_SIGNING_DOMAIN, indexBytes) },
        });

        expect(result).toMatchObject({ error: { code: "INVALID_INDEX" }, ok: false });
    });

    it("binds a fetched manifest to the index entry by its sha256", async () => {
        const manifestBytes = encoder.encode('{"slug":"counter"}');
        const entry = {
            artifactUrl: "https://catalog.example.com/x.zip",
            manifestSha256: await sha256Hex(manifestBytes),
            manifestUrl: "https://catalog.example.com/x.manifest.json",
            name: "Counter",
            signatureUrl: "https://catalog.example.com/x.manifest.sig",
            slug: "counter",
            version: "1.0.0",
        };

        await expect(manifestMatchesIndex(entry, manifestBytes)).resolves.toBe(true);
        await expect(manifestMatchesIndex(entry, encoder.encode('{"slug":"other"}'))).resolves.toBe(false);
    });
});

describe(decodeBase64, () => {
    it("rejects text that is not base64", () => {
        expect(decodeBase64("%%%not base64%%%")).toBeUndefined();
    });
});

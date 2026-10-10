import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { AppSource, AppSpec } from "../scripts/catalog/publish-core";
import { compareVersions, generateKeyPair, importPrivateKey, packApp, publishCatalog, readAppSource, writeCatalog } from "../scripts/catalog/publish-core";
import { verifyArtifact } from "../src/catalog/artifact";
import { verifyCatalogIndex } from "../src/catalog/index";
import type { TrustedCatalogKey } from "../src/catalog/signature";
import { parseDetachedSignature, sha256Hex } from "../src/catalog/signature";
import okOf from "./catalog-helpers";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const KEY_ID = "catalog-test";
const NOW = new Date("2026-10-10T12:00:00.000Z");

const build = {
    "assets/style.css": encoder.encode("body { margin: 0 }"),
    "worker.js": encoder.encode('export default { fetch: () => new Response("ok") };'),
};

const spec = (overrides: Partial<AppSpec> = {}): AppSpec => {
    return {
        main: "worker.js",
        name: "Counter",
        slug: "counter",
        summary: "Counts requests.",
        version: "1.0.0",
        ...overrides,
    };
};

const app = (overrides: Partial<AppSpec> = {}): AppSource => {
    return { files: build, spec: spec(overrides) };
};

/** The key the publisher prints, parsed back the way the control plane reads `CATALOG_PUBLIC_KEYS`. */
const trustedFrom = (publicLine: string): TrustedCatalogKey => {
    const parsed = JSON.parse(publicLine) as { keyId: string; publicKey: string };

    return { keyId: parsed.keyId, publicKey: new Uint8Array(Buffer.from(parsed.publicKey, "base64")) };
};

const signer = async () => {
    const pair = await generateKeyPair(KEY_ID);

    return { privateKey: await importPrivateKey(pair.privatePem), pair, trusted: trustedFrom(pair.publicLine) };
};

const bytesOf = (path: string): Uint8Array => new Uint8Array(readFileSync(path));

describe("catalog publishing", () => {
    let directory: string;

    beforeEach(() => {
        directory = mkdtempSync(join(tmpdir(), "catalog-publish-"));
    });

    afterEach(() => {
        rmSync(directory, { force: true, recursive: true });
    });

    it("prints a public key line the control plane can read, and returns a private key that imports", async () => {
        const pair = await generateKeyPair(KEY_ID);
        const parsed = JSON.parse(pair.publicLine) as { keyId: string; publicKey: string };

        expect(parsed.keyId).toBe(KEY_ID);
        expect(Buffer.from(parsed.publicKey, "base64")).toHaveLength(32);
        expect(pair.publicLine).not.toContain("PRIVATE");
        expect(pair.privatePem).toMatch(/^-----BEGIN PRIVATE KEY-----\n/u);
        await expect(importPrivateKey(pair.privatePem)).resolves.toBeDefined();
    });

    it("packs a release that the real verifier accepts under the printed key, including the runtime", async () => {
        const { privateKey, trusted } = await signer();
        const release = await packApp({ files: build, keyId: KEY_ID, privateKey, spec: spec({ runtime: "lunora" }) });

        const result = await verifyArtifact({ ...release, keys: [trusted] });

        const verified = okOf(result);

        expect(verified.manifest).toMatchObject({ main: "worker.js", runtime: "lunora", slug: "counter", version: "1.0.0" });
        expect(verified.files.get("assets/style.css")).toStrictEqual(build["assets/style.css"]);
    });

    it("refuses a bad main module", async () => {
        const { privateKey } = await signer();

        await expect(publishCatalog({ apps: [app({ main: "index.js" })], baseUrl: "https://catalog.example.com", keyId: KEY_ID, privateKey })).rejects.toThrow(
            "main must name one of the listed files",
        );
    });

    it("refuses a version that is not major.minor.patch", async () => {
        const { privateKey } = await signer();

        await expect(
            publishCatalog({ apps: [app({ version: "1.0.0-beta" })], baseUrl: "https://catalog.example.com", keyId: KEY_ID, privateKey }),
        ).rejects.toThrow("is not semver");
    });

    it("refuses a base URL that is not https", async () => {
        const { privateKey } = await signer();

        await expect(publishCatalog({ apps: [], baseUrl: "http://catalog.example.com", keyId: KEY_ID, privateKey })).rejects.toThrow("must be https");
    });

    it("publishes files that the real artifact and index verifiers accept under the printed key", async () => {
        const { privateKey, trusted } = await signer();
        const apps = [
            app({ version: "1.2.0" }),
            app({ version: "1.10.0" }),
            app({ version: "1.9.9" }),
            app({ name: "Notes", slug: "notes", summary: "", version: "0.3.0" }),
        ];

        const catalog = await publishCatalog({ apps, baseUrl: "https://catalog.example.com/apps/", keyId: KEY_ID, now: NOW, privateKey });

        // Written and read back from disk, as the CLI does.
        writeCatalog(directory, catalog);

        const indexBytes = bytesOf(join(directory, "index.json"));
        const indexSignature = parseDetachedSignature(bytesOf(join(directory, "index.sig")));

        if (indexSignature === undefined) {
            throw new Error("index.sig is not a detached signature");
        }

        const index = await verifyCatalogIndex({ indexBytes, keys: [trusted], now: NOW.getTime(), signature: indexSignature });

        expect(index.ok).toBe(true);

        if (!index.ok) {
            return;
        }

        expect(index.entries.map((entry) => entry.slug)).toStrictEqual(["counter", "notes"]);

        const counter = index.entries.find((entry) => entry.slug === "counter");

        expect(counter).toMatchObject({
            artifactUrl: "https://catalog.example.com/apps/counter-1.10.0.zip",
            manifestUrl: "https://catalog.example.com/apps/counter-1.10.0.manifest.json",
            name: "Counter",
            signatureUrl: "https://catalog.example.com/apps/counter-1.10.0.manifest.sig",
            summary: "Counts requests.",
            version: "1.10.0",
        });
        expect(index.entries.find((entry) => entry.slug === "notes")).not.toHaveProperty("summary");

        // Each listed release verifies from its files on disk, and its manifest hashes to the index's digest.
        const checks = await Promise.all(
            index.entries.map(async (entry) => {
                const stem = join(directory, `${entry.slug}-${entry.version}`);
                const manifestBytes = bytesOf(`${stem}.manifest.json`);
                const signature = parseDetachedSignature(bytesOf(`${stem}.manifest.sig`));

                if (signature === undefined) {
                    throw new Error(`${entry.slug}@${entry.version} has no manifest signature file`);
                }

                return {
                    digest: await sha256Hex(manifestBytes),
                    entry,
                    verified: await verifyArtifact({ archive: bytesOf(`${stem}.zip`), keys: [trusted], manifestBytes, signature }),
                };
            }),
        );

        for (const { digest, entry, verified } of checks) {
            expect(digest).toBe(entry.manifestSha256);

            okOf(verified);
        }

        // Only the listed (highest) versions are written.
        expect(existsSync(join(directory, "counter-1.10.0.zip"))).toBe(true);
        expect(existsSync(join(directory, "counter-1.2.0.zip"))).toBe(false);
        expect(existsSync(join(directory, "counter-1.9.9.zip"))).toBe(false);
    });

    it("stamps the index with an ISO-8601 issuedAt", async () => {
        const { privateKey } = await signer();

        const pinned = await publishCatalog({ apps: [app()], baseUrl: "https://catalog.example.com", keyId: KEY_ID, now: NOW, privateKey });
        const pinnedIndex = JSON.parse(decoder.decode(pinned.indexBytes)) as { issuedAt: unknown };

        expect(pinnedIndex.issuedAt).toBe("2026-10-10T12:00:00.000Z");

        const before = Date.now();
        const live = await publishCatalog({ apps: [app()], baseUrl: "https://catalog.example.com", keyId: KEY_ID, privateKey });
        const liveIssuedAt = (JSON.parse(decoder.decode(live.indexBytes)) as { issuedAt: string }).issuedAt;

        expect(new Date(liveIssuedAt).toISOString()).toBe(liveIssuedAt);
        expect(Date.parse(liveIssuedAt)).toBeGreaterThanOrEqual(before - 1000);
    });

    it("lists the highest semver version of each app, whatever order they are given in", async () => {
        const { privateKey } = await signer();

        expect(compareVersions("1.10.0", "1.9.9")).toBeGreaterThan(0);

        const catalog = await publishCatalog({
            apps: [app({ version: "1.10.0" }), app({ version: "1.9.9" }), app({ version: "1.2.0" })],
            baseUrl: "https://catalog.example.com",
            keyId: KEY_ID,
            now: NOW,
            privateKey,
        });
        const listed = (JSON.parse(decoder.decode(catalog.indexBytes)) as { apps: { version: string }[] }).apps;

        expect(listed.map((entry) => entry.version)).toStrictEqual(["1.10.0"]);
    });

    it("packs the sample app with its assets binding, and the real verifier accepts it", async () => {
        const { privateKey, trusted } = await signer();
        const sampleRoot = fileURLToPath(new URL("../catalog/apps", import.meta.url));
        const source = readAppSource(join(sampleRoot, "counter"));

        expect(source.spec.bindings).toStrictEqual([{ binding: "ASSETS", type: "assets" }]);

        const catalog = await publishCatalog({ apps: [source], baseUrl: "https://catalog.example.com", keyId: KEY_ID, now: NOW, privateKey });

        expect(catalog.releases).toHaveLength(1);

        const release = catalog.releases.at(0);

        if (release === undefined) {
            throw new Error("the sample app was not packed");
        }

        const verified = await verifyArtifact({
            archive: release.archive,
            keys: [trusted],
            manifestBytes: release.manifestBytes,
            signature: release.signature,
        });

        const checked = okOf(verified);

        expect(checked.manifest.bindings).toStrictEqual([{ binding: "ASSETS", type: "assets" }]);
        expect([...checked.files.keys()].toSorted((left, right) => left.localeCompare(right))).toStrictEqual(["assets/style.css", "worker.js"]);
    });
});

import { describe, expect, it } from "vitest";

import { verifyArtifact } from "../src/catalog/artifact";
import { packArtifact } from "../src/catalog/pack";
import type { TrustedCatalogKey } from "../src/catalog/signature";
import okOf from "./catalog-helpers";

const encoder = new TextEncoder();

/** A catalog signing key as its CI holds it, and the public half the control plane trusts. */
const generateCatalogKey = async (keyId: string): Promise<{ privateKey: CryptoKey; trusted: TrustedCatalogKey }> => {
    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));

    return { privateKey: pair.privateKey, trusted: { keyId, publicKey } };
};

const build = {
    "assets/app.css": encoder.encode("body { color: black }"),
    "worker.js": encoder.encode('export default { fetch: () => new Response("ok") };'),
};

describe(packArtifact, () => {
    it("packs an artifact that the verifier accepts under the matching public key", async () => {
        const key = await generateCatalogKey("catalog-2026");
        const packed = await packArtifact({
            files: build,
            keyId: "catalog-2026",
            main: "worker.js",
            privateKey: key.privateKey,
            slug: "counter",
            version: "1.2.0",
        });

        const result = await verifyArtifact({ ...packed, keys: [key.trusted] });

        const verified = okOf(result);

        expect(verified.manifest).toMatchObject({ main: "worker.js", slug: "counter", version: "1.2.0" });
        expect(verified.files.get("assets/app.css")).toStrictEqual(build["assets/app.css"]);
    });

    it("carries the binding manifest through to the verified manifest unchanged", async () => {
        const key = await generateCatalogKey("catalog-2026");
        const bindings = [{ binding: "ASSETS", type: "assets" }];
        const packed = await packArtifact({
            bindings,
            files: build,
            keyId: "catalog-2026",
            main: "worker.js",
            privateKey: key.privateKey,
            slug: "counter",
            version: "1.2.0",
        });

        const result = await verifyArtifact({ ...packed, keys: [key.trusted] });

        expect(result).toMatchObject({ manifest: { bindings }, ok: true });
    });

    it("refuses to pack when the main module is not one of the files", async () => {
        const key = await generateCatalogKey("catalog-2026");

        await expect(
            packArtifact({ files: build, keyId: "catalog-2026", main: "index.js", privateKey: key.privateKey, slug: "counter", version: "1.2.0" }),
        ).rejects.toThrow("main must name one of the listed files");
    });

    it("refuses to pack a slug the catalog does not allow", async () => {
        const key = await generateCatalogKey("catalog-2026");

        await expect(
            packArtifact({ files: build, keyId: "catalog-2026", main: "worker.js", privateKey: key.privateKey, slug: "Counter App", version: "1.2.0" }),
        ).rejects.toThrow("slug must be lowercase");
    });
});

/**
 * The publishing side of a catalog artifact: pack a built Worker into the archive
 * and manifest the verifier reads, then sign the manifest. Packing runs the same
 * manifest parser the control plane uses, so an artifact that packs is an artifact
 * that verifies. A catalog's CI calls this; the private key never leaves it.
 */
import { zipSync } from "fflate";

import type { ArtifactFile, CatalogForm, CatalogManifest } from "./artifact";
import { CATALOG_FORMAT, parseManifest } from "./artifact";
import type { DetachedSignature } from "./signature";
import { ARTIFACT_SIGNING_DOMAIN, sha256Hex, signPayload } from "./signature";

export interface PackInput {
    /** Binding manifest for the deploy core, passed through unchanged. */
    bindings?: unknown[];
    /** Every file of the build, keyed by its path inside the archive. */
    files: Record<string, Uint8Array>;
    /** What the install page asks for. */
    form?: CatalogForm;
    /** Id of the signing key; the control plane looks the public half up by it. */
    keyId: string;
    /** Path of the Worker entry module. */
    main: string;
    privateKey: CryptoKey;
    /** `lunora` for a Lunora app, `worker` for a plain Worker; absent means `worker`. */
    runtime?: "lunora" | "worker";
    slug: string;
    version: string;
}

export interface PackedArtifact {
    archive: Uint8Array;
    manifestBytes: Uint8Array;
    signature: DetachedSignature;
}

/**
 * Pack and sign an artifact. Throws when the inputs would not verify: a bad slug,
 * an unsafe path, or a main module that is not one of the files.
 */
export const packArtifact = async (input: PackInput): Promise<PackedArtifact> => {
    const files: ArtifactFile[] = await Promise.all(
        Object.entries(input.files).map(async ([path, bytes]) => {
            return { path, sha256: await sha256Hex(bytes), size: bytes.byteLength };
        }),
    );
    const manifest: CatalogManifest = {
        ...(input.bindings === undefined ? {} : { bindings: input.bindings }),
        ...(input.form === undefined ? {} : { form: input.form }),
        ...(input.runtime === undefined ? {} : { runtime: input.runtime }),
        files: files.toSorted((a, b) => a.path.localeCompare(b.path)),
        format: CATALOG_FORMAT,
        main: input.main,
        slug: input.slug,
        version: input.version,
    };
    const parsed = parseManifest(structuredClone(manifest));

    if (!parsed.ok) {
        throw new Error(`cannot pack ${input.slug}@${input.version}: ${parsed.error.message}`);
    }

    const manifestBytes = new TextEncoder().encode(JSON.stringify(manifest));

    return {
        archive: zipSync(input.files),
        manifestBytes,
        signature: { keyId: input.keyId, signature: await signPayload(input.privateKey, ARTIFACT_SIGNING_DOMAIN, manifestBytes) },
    };
};

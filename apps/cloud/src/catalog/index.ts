/**
 * A catalog's signed index: the apps it lists, each with its latest version and
 * where to fetch the artifact, its manifest and the manifest's signature. The index
 * is signed under its own domain tag, and it carries `issuedAt`, so a host cannot
 * keep serving an old signed index for ever: one older than {@link MAX_INDEX_AGE_MS}
 * is refused. Verification checks the signature before anything in the bytes is read.
 */
import { CATALOG_FORMAT } from "./artifact";
import { isHttpsUrl, isVersion, MAX_NAME_LENGTH, MAX_SUMMARY_LENGTH, SHA256, SLUG } from "./fields";
import type { DetachedSignature, TrustedCatalogKey } from "./signature";
import { INDEX_SIGNING_DOMAIN, sha256Hex, verifyDetached } from "./signature";

/** An index whose `issuedAt` is older than this is refused. */
export const MAX_INDEX_AGE_MS = 14 * 24 * 60 * 60 * 1000;

/** Clock skew tolerated when an index claims to be issued slightly in the future. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** One app in the index: its latest release, and where its three files are. */
export interface CatalogIndexEntry {
    artifactUrl: string;
    manifestSha256: string;
    manifestUrl: string;
    name: string;
    signatureUrl: string;
    slug: string;
    summary?: string;
    version: string;
}

export type CatalogIndexResult = { entries: CatalogIndexEntry[]; issuedAt: number; ok: true } | { error: { code: string; message: string }; ok: false };

const invalid = (message: string): { error: { code: string; message: string }; ok: false } => {
    return { error: { code: "INVALID_INDEX", message }, ok: false };
};

/** Read one index entry, refusing anything the publisher would not have written. */
const readEntry = (item: unknown): { entry: CatalogIndexEntry; ok: true } | { error: { code: string; message: string }; ok: false } => {
    const app = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;
    const { slug } = app;

    if (typeof slug !== "string" || !SLUG.test(slug)) {
        return invalid(`app slug ${String(slug)} is missing or malformed`);
    }

    if (!isVersion(app["version"])) {
        return invalid(`app ${slug} needs a version`);
    }

    if (typeof app["name"] !== "string" || app["name"].length === 0 || app["name"].length > MAX_NAME_LENGTH) {
        return invalid(`app ${slug} needs a name of 1 to ${String(MAX_NAME_LENGTH)} characters`);
    }

    if (app["summary"] !== undefined && (typeof app["summary"] !== "string" || app["summary"].length > MAX_SUMMARY_LENGTH)) {
        return invalid(`app ${slug} summary must be at most ${String(MAX_SUMMARY_LENGTH)} characters`);
    }

    for (const field of ["artifactUrl", "manifestUrl", "signatureUrl"] as const) {
        if (typeof app[field] !== "string" || !isHttpsUrl(app[field])) {
            return invalid(`app ${slug} needs an https ${field}`);
        }
    }

    if (typeof app["manifestSha256"] !== "string" || !SHA256.test(app["manifestSha256"])) {
        return invalid(`app ${slug} needs a lowercase hex manifest sha256`);
    }

    return {
        entry: {
            artifactUrl: app["artifactUrl"] as string,
            manifestSha256: app["manifestSha256"],
            manifestUrl: app["manifestUrl"] as string,
            name: app["name"],
            signatureUrl: app["signatureUrl"] as string,
            slug,
            ...(typeof app["summary"] === "string" ? { summary: app["summary"] } : {}),
            version: app["version"],
        },
        ok: true,
    };
};

/**
 * Verify and parse a catalog index. The signature is checked over the exact bytes
 * published, before anything in them is read; then the timestamp is checked
 * against `now`, and each entry against the field rules.
 */
export const verifyCatalogIndex = async (input: {
    indexBytes: Uint8Array;
    keys: TrustedCatalogKey[];
    now: number;
    signature: DetachedSignature;
}): Promise<CatalogIndexResult> => {
    const signed = await verifyDetached(input.keys, INDEX_SIGNING_DOMAIN, input.indexBytes, input.signature);

    if (!signed.ok) {
        return { error: { code: signed.code, message: signed.message }, ok: false };
    }

    let raw: unknown;

    try {
        raw = JSON.parse(new TextDecoder().decode(input.indexBytes));
    } catch {
        return invalid("the index is not valid JSON");
    }

    const record = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;

    if (record["format"] !== CATALOG_FORMAT) {
        return { error: { code: "UNSUPPORTED_FORMAT", message: `the index is not format ${String(CATALOG_FORMAT)}` }, ok: false };
    }

    const issuedAt = typeof record["issuedAt"] === "string" ? Date.parse(record["issuedAt"]) : Number.NaN;

    if (Number.isNaN(issuedAt)) {
        return invalid("the index needs an issuedAt timestamp");
    }

    if (issuedAt > input.now + MAX_CLOCK_SKEW_MS) {
        return invalid("the index is dated in the future");
    }

    if (input.now - issuedAt > MAX_INDEX_AGE_MS) {
        return invalid("the index is too old to trust; the catalog publisher must issue a fresh one");
    }

    if (!Array.isArray(record["apps"])) {
        return invalid("the index has no apps list");
    }

    const entries: CatalogIndexEntry[] = [];
    const slugs = new Set<string>();

    for (const item of record["apps"]) {
        const read = readEntry(item);

        if (!read.ok) {
            return read;
        }

        if (slugs.has(read.entry.slug)) {
            return invalid(`app ${read.entry.slug} is listed twice`);
        }

        slugs.add(read.entry.slug);
        entries.push(read.entry);
    }

    return { entries, issuedAt, ok: true };
};

/** Whether a fetched manifest is the one the index names: its bytes must hash to the index's `manifestSha256`. */
export const manifestMatchesIndex = async (entry: CatalogIndexEntry, manifestBytes: Uint8Array): Promise<boolean> =>
    (await sha256Hex(manifestBytes)) === entry.manifestSha256;

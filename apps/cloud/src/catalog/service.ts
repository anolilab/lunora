/**
 * The catalog's control-plane service: reads the official signed index from the
 * environment, verifies it and every app it lists, and installs one app into a
 * project. Pure over its transport and the install ports, so the routes in
 * `src/deploy/routes/catalog.ts` only map requests and failures onto HTTP.
 *
 * Nothing unverified is shown or installed. An index that fails verification is not
 * served; a listed app whose manifest fails any check is reported in `skipped` with
 * its reason; an install verifies everything it fetches before it plans anything.
 */
import type { ArtifactErrorCode, CatalogForm, CatalogManifest } from "./artifact";
import { MAX_ARTIFACT_BYTES, verifyArchive, verifyManifestBytes } from "./artifact";
import { isHttpsUrl } from "./fields";
import type { CatalogIndexEntry } from "./index";
import { manifestMatchesIndex, verifyCatalogIndex } from "./index";
import type { InstallFailure, InstallPorts, InstallValues } from "./install";
import { runInstall } from "./install";
import type { DetachedSignature, TrustedCatalogKey } from "./signature";
import { decodeBase64, MAX_SIGNATURE_FILE_BYTES, parseDetachedSignature } from "./signature";

/** How long a verified index is served before it is fetched and verified again. */
export const INDEX_TTL_MS = 5 * 60 * 1000;

/** Largest index accepted. */
const MAX_INDEX_BYTES = 1024 * 1024;

/** Largest manifest accepted; a manifest lists files and carries no payload. */
const MAX_MANIFEST_BYTES = 1024 * 1024;

const ED25519_PUBLIC_KEY_BYTES = 32;

/** The catalog's environment, as the control plane's Env declares it. */
export interface CatalogEnv {
    CATALOG_INDEX_URL?: string;
    CATALOG_PUBLIC_KEYS?: string;
}

/** What the environment says about the catalog. */
export type CatalogConfig =
    { kind: "empty" } | { fingerprint: string; indexUrl: string; keys: TrustedCatalogKey[]; kind: "ready" } | { error: string; kind: "refused" };

/** Parse `CATALOG_PUBLIC_KEYS`: a JSON array of `{ keyId, publicKey }`, the key being the standard base64 of the raw 32-byte Ed25519 key. */
const parseKeys = (text: string): { error: string } | { keys: TrustedCatalogKey[] } => {
    let raw: unknown;

    try {
        raw = JSON.parse(text);
    } catch {
        return { error: "CATALOG_PUBLIC_KEYS is not valid JSON" };
    }

    if (!Array.isArray(raw) || raw.length === 0) {
        return { error: "CATALOG_PUBLIC_KEYS must be a non-empty JSON array of { keyId, publicKey }" };
    }

    const keys: TrustedCatalogKey[] = [];
    const ids = new Set<string>();

    for (const item of raw) {
        const { keyId, publicKey } = (typeof item === "object" && item !== null ? item : {}) as Record<string, unknown>;

        if (typeof keyId !== "string" || keyId.length === 0) {
            return { error: "every CATALOG_PUBLIC_KEYS entry needs a keyId" };
        }

        if (ids.has(keyId)) {
            return { error: `CATALOG_PUBLIC_KEYS names key ${keyId} twice` };
        }

        const bytes = typeof publicKey === "string" ? decodeBase64(publicKey) : undefined;

        if (bytes?.byteLength !== ED25519_PUBLIC_KEY_BYTES) {
            return { error: `key ${keyId} is not the standard base64 of a raw 32-byte Ed25519 public key` };
        }

        ids.add(keyId);
        keys.push({ keyId, publicKey: bytes });
    }

    return { keys };
};

/**
 * Read the catalog from its environment. An absent `CATALOG_INDEX_URL` is an empty
 * catalog. Anything else that is missing or malformed is a refusal, never an empty
 * list, so a misconfigured deployment is visible rather than quietly bare.
 */
export const readCatalogConfig = (env: CatalogEnv): CatalogConfig => {
    const indexUrl = env.CATALOG_INDEX_URL?.trim() ?? "";

    if (indexUrl === "") {
        return { kind: "empty" };
    }

    if (!isHttpsUrl(indexUrl)) {
        return { error: "CATALOG_INDEX_URL must be an https URL", kind: "refused" };
    }

    const keysText = env.CATALOG_PUBLIC_KEYS?.trim() ?? "";

    if (keysText === "") {
        return { error: "CATALOG_PUBLIC_KEYS is not set, so the catalog index cannot be verified", kind: "refused" };
    }

    const parsed = parseKeys(keysText);

    if ("error" in parsed) {
        return { error: parsed.error, kind: "refused" };
    }

    return { fingerprint: `${indexUrl}\n${keysText}`, indexUrl, keys: parsed.keys, kind: "ready" };
};

/** The transport the service reads through: a fetch, and a clock. */
export interface CatalogDeps {
    env: CatalogEnv;
    fetch: (url: string) => Promise<Response>;
    now: () => number;
}

/** One install row, as the org's live `catalogInstalls` hold it. */
export interface CatalogInstallRow {
    deploymentId: string;
    projectId: string;
    slug: string;
    version: string;
}

export interface CatalogListDeps extends CatalogDeps {
    /** The org's live installs, read through `api.catalog.installs`. */
    installs: (organizationId: string) => Promise<CatalogInstallRow[]>;
}

/** An app the control plane can install: a verified index entry and a verified manifest. */
export interface CatalogApp {
    form: CatalogForm;
    installs: { deploymentId: string; projectId: string; version: string }[];
    name: string;
    slug: string;
    summary?: string;
    version: string;
}

/** A listed app that did not pass verification, and why. Never installable. */
export interface CatalogSkipped {
    reason: string;
    slug: string;
    version: string;
}

export type CatalogListing = { apps: CatalogApp[]; ok: true; skipped: CatalogSkipped[] } | { error: string; ok: false };

type ReadyConfig = Extract<CatalogConfig, { kind: "ready" }>;

interface CachedIndex {
    entries: CatalogIndexEntry[];
    expiresAt: number;
    fingerprint: string;
}

/** The last index that verified, served until it expires. Only verified results are ever stored. */
let cachedIndex: CachedIndex | undefined;

/** The newest index this isolate has verified. An older signed index is refused, so a host cannot roll the catalog back. */
let highestIssuedAt = 0;

/** Drop the cached index. Tests use this; production lets the TTL expire. */
export const resetCatalogIndexCache = (): void => {
    cachedIndex = undefined;
    highestIssuedAt = 0;
};

class FetchFailure extends Error {}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : "unknown error");

/**
 * Fetch a body of at most `limit` bytes. A non-2xx answer, an over-long body or a
 * network error throws, so each caller answers with its own failure kind.
 */
const fetchBounded = async (fetcher: CatalogDeps["fetch"], url: string, limit: number): Promise<Uint8Array> => {
    const response = await fetcher(url);

    if (!response.ok) {
        await response.body?.cancel();
        throw new FetchFailure(`${url} answered ${String(response.status)}`);
    }

    const declared = response.headers.get("content-length");

    if (declared !== null && Number(declared) > limit) {
        await response.body?.cancel();
        throw new FetchFailure(`${url} is over the ${String(limit)}-byte limit`);
    }

    const reader = response.body?.getReader();

    if (reader === undefined) {
        return new Uint8Array(0);
    }

    const chunks: Uint8Array[] = [];
    let total = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop -- a body is read in order; each chunk depends on the last
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > limit) {
            reader.cancel().catch(() => undefined);
            throw new FetchFailure(`${url} is over the ${String(limit)}-byte limit`);
        }

        chunks.push(value);
    }

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }

    return bytes;
};

/** The index's verified entries, served from the cache while fresh; otherwise fetched, verified and cached. */
type IndexLoad = { entries: CatalogIndexEntry[]; ok: true } | { error: string; ok: false };

const loadIndex = async (deps: CatalogDeps, config: ReadyConfig): Promise<IndexLoad> => {
    const now = deps.now();

    if (cachedIndex?.fingerprint === config.fingerprint && now < cachedIndex.expiresAt) {
        return { entries: cachedIndex.entries, ok: true };
    }

    cachedIndex = undefined;

    let indexBytes: Uint8Array;
    let signatureBytes: Uint8Array;

    try {
        indexBytes = await fetchBounded(deps.fetch, config.indexUrl, MAX_INDEX_BYTES);
        signatureBytes = await fetchBounded(deps.fetch, new URL("index.sig", config.indexUrl).href, MAX_SIGNATURE_FILE_BYTES);
    } catch (error) {
        return { error: `the catalog index could not be fetched: ${messageOf(error)}`, ok: false };
    }

    const signature = parseDetachedSignature(signatureBytes);

    if (signature === undefined) {
        return { error: "the catalog index signature is malformed", ok: false };
    }

    const verified = await verifyCatalogIndex({ indexBytes, keys: config.keys, now, signature });

    if (!verified.ok) {
        return { error: `the catalog index failed verification: ${verified.error.message}`, ok: false };
    }

    if (verified.issuedAt < highestIssuedAt) {
        return { error: "the catalog index is older than one this control plane has already served", ok: false };
    }

    highestIssuedAt = verified.issuedAt;
    cachedIndex = { entries: verified.entries, expiresAt: now + INDEX_TTL_MS, fingerprint: config.fingerprint };

    return { entries: verified.entries, ok: true };
};

/** A manifest that passed every check, with its bytes for the archive check that follows. */
interface CheckedManifest {
    manifest: CatalogManifest;
    manifestBytes: Uint8Array;
}

/**
 * Check one listed app's manifest against its index entry: the bytes must hash to
 * the index's sha256, the signature must verify under the artifact domain, the
 * manifest must parse, and it must name the same slug and version the index does.
 */
const checkManifest = async (
    keys: TrustedCatalogKey[],
    entry: CatalogIndexEntry,
    manifestBytes: Uint8Array,
    signatureBytes: Uint8Array,
): Promise<{ ok: true; value: CheckedManifest } | { code: ArtifactErrorCode; ok: false; reason: string }> => {
    if (!(await manifestMatchesIndex(entry, manifestBytes))) {
        return { code: "HASH_MISMATCH", ok: false, reason: "its manifest does not match the sha256 the index names" };
    }

    const signature: DetachedSignature | undefined = parseDetachedSignature(signatureBytes);

    if (signature === undefined) {
        return { code: "BAD_SIGNATURE", ok: false, reason: "its manifest signature is malformed" };
    }

    const verified = await verifyManifestBytes(keys, manifestBytes, signature);

    if (!verified.ok) {
        const reasons: Partial<Record<ArtifactErrorCode, string>> = {
            BAD_SIGNATURE: "its manifest signature does not verify",
            UNKNOWN_KEY: "its manifest is signed by a key that is not trusted",
        };

        return { code: verified.error.code, ok: false, reason: reasons[verified.error.code] ?? `its manifest is invalid: ${verified.error.message}` };
    }

    if (verified.manifest.slug !== entry.slug || verified.manifest.version !== entry.version) {
        return { code: "INVALID_MANIFEST", ok: false, reason: "its manifest names a different app or version than the index does" };
    }

    return { ok: true, value: { manifest: verified.manifest, manifestBytes } };
};

/** Fetch an entry's manifest and signature, then check them. */
const fetchAndCheck = async (
    deps: CatalogDeps,
    keys: TrustedCatalogKey[],
    entry: CatalogIndexEntry,
): Promise<{ ok: true; value: CheckedManifest } | { code: ArtifactErrorCode | "FETCH"; ok: false; reason: string }> => {
    let manifestBytes: Uint8Array;
    let signatureBytes: Uint8Array;

    try {
        manifestBytes = await fetchBounded(deps.fetch, entry.manifestUrl, MAX_MANIFEST_BYTES);
        signatureBytes = await fetchBounded(deps.fetch, entry.signatureUrl, MAX_SIGNATURE_FILE_BYTES);
    } catch (error) {
        return { code: "FETCH", ok: false, reason: `its manifest could not be fetched: ${messageOf(error)}` };
    }

    return checkManifest(keys, entry, manifestBytes, signatureBytes);
};

/**
 * The catalog an organization can browse. Every listed app is verified on its own:
 * one that fails is reported in `skipped` with its reason and never listed as
 * installable. A catalog that is not configured, or whose index cannot be verified,
 * is an error, not an empty list.
 */
export const listCatalog = async (deps: CatalogListDeps, organizationId: string): Promise<CatalogListing> => {
    const config = readCatalogConfig(deps.env);

    if (config.kind === "empty") {
        return { apps: [], ok: true, skipped: [] };
    }

    if (config.kind === "refused") {
        return { error: config.error, ok: false };
    }

    const index = await loadIndex(deps, config);

    if (!index.ok) {
        return { error: index.error, ok: false };
    }

    const installs = await deps.installs(organizationId);
    const checked = await Promise.all(
        index.entries.map((entry) =>
            fetchAndCheck(deps, config.keys, entry).then((result) => {
                return { entry, result };
            }),
        ),
    );
    const apps: CatalogApp[] = [];
    const skipped: CatalogSkipped[] = [];

    for (const { entry, result } of checked) {
        if (!result.ok) {
            skipped.push({ reason: result.reason, slug: entry.slug, version: entry.version });
            continue;
        }

        const { manifest } = result.value;

        apps.push({
            form: manifest.form ?? { secrets: [], vars: [] },
            installs: installs
                .filter((install) => install.slug === entry.slug)
                .map((install) => {
                    return { deploymentId: install.deploymentId, projectId: install.projectId, version: install.version };
                }),
            name: entry.name,
            slug: entry.slug,
            ...(entry.summary === undefined ? {} : { summary: entry.summary }),
            version: entry.version,
        });
    }

    return { apps, ok: true, skipped };
};

/** The project's production alias: the Worker a release lands on. `undefined` when the project has none yet. */
export type InstallTarget = { scriptName?: string } | null;

/** What an install needs from its edge: the ports, and the project's production target. */
export interface InstallAdapters {
    ports: InstallPorts;
    /** The project's production alias, or `null` when the project is not in this organization. */
    target: () => Promise<InstallTarget>;
}

/** What the install route received, once its body is parsed. */
export interface InstallRequest {
    installedBy: string;
    organizationId: string;
    projectId: string;
    slug: string;
    values: InstallValues;
}

/** Why an install did not happen. The route maps each kind to one HTTP status. */
export type InstallFailureKind = "busy" | "conflict" | "internal" | "invalidInput" | "notFound" | "unavailable" | "upstream" | "verification";

export type InstallOutcome =
    | { deploymentId: string; generated: string[]; kept: string[]; ok: true; recorded: boolean; url?: string }
    | { code?: ArtifactErrorCode; error: string; field?: string; kind: InstallFailureKind; ok: false };

const refuse = (kind: InstallFailureKind, error: string, code?: ArtifactErrorCode): InstallOutcome => {
    return {
        error,
        kind,
        ok: false,
        ...(code === undefined ? {} : { code }),
    };
};

/**
 * Install one app into a project: find its index entry, fetch its archive, manifest
 * and signature, verify all of them, then run the install core. Never returns a
 * secret value.
 */
export const installApp = async (deps: CatalogDeps, request: InstallRequest, adapters: InstallAdapters): Promise<InstallOutcome> => {
    const config = readCatalogConfig(deps.env);

    if (config.kind === "refused") {
        return refuse("unavailable", config.error);
    }

    if (config.kind === "empty") {
        return refuse("notFound", `no app named ${request.slug} is in the catalog`);
    }

    const index = await loadIndex(deps, config);

    if (!index.ok) {
        return refuse("unavailable", index.error);
    }

    const entry = index.entries.find((candidate) => candidate.slug === request.slug);

    if (entry === undefined) {
        return refuse("notFound", `no app named ${request.slug} is in the catalog`);
    }

    const target = await adapters.target();

    if (target === null) {
        return refuse("notFound", "project not found in this organization");
    }

    if (target.scriptName === undefined) {
        return refuse("conflict", "this project has no production alias yet; deploy it once before installing a catalog app");
    }

    let archive: Uint8Array;
    let manifestBytes: Uint8Array;
    let signatureBytes: Uint8Array;

    try {
        archive = await fetchBounded(deps.fetch, entry.artifactUrl, MAX_ARTIFACT_BYTES);
        manifestBytes = await fetchBounded(deps.fetch, entry.manifestUrl, MAX_MANIFEST_BYTES);
        signatureBytes = await fetchBounded(deps.fetch, entry.signatureUrl, MAX_SIGNATURE_FILE_BYTES);
    } catch (error) {
        return refuse("upstream", `the app's files could not be fetched: ${messageOf(error)}`);
    }

    const checked = await checkManifest(config.keys, entry, manifestBytes, signatureBytes);

    if (!checked.ok) {
        return refuse("verification", checked.reason, checked.code);
    }

    const archiveChecked = await verifyArchive(archive, checked.value.manifest);

    if (!archiveChecked.ok) {
        return refuse("verification", archiveChecked.error.message, archiveChecked.error.code);
    }

    const result = await runInstall(
        {
            artifact: { files: archiveChecked.files, manifest: checked.value.manifest },
            installedBy: request.installedBy,
            organizationId: request.organizationId,
            projectId: request.projectId,
            scriptName: target.scriptName,
            slug: request.slug,
            values: request.values,
        },
        adapters.ports,
    );

    if (!result.ok) {
        const failed: InstallFailure = result;

        return { error: failed.error, kind: failed.kind, ...(failed.field === undefined ? {} : { field: failed.field }), ok: false };
    }

    return {
        deploymentId: result.deploymentId,
        generated: result.generated,
        kept: result.kept,
        ok: true,
        recorded: result.recorded,
        ...(result.url === undefined ? {} : { url: result.url }),
    };
};

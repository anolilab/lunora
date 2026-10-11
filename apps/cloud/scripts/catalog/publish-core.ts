/**
 * The catalog publisher's core: key generation, packing each app into a signed
 * release, and building the signed index. Everything happens in memory. `publish.ts`
 * reads the app directories and writes the result, and the tests call these
 * functions directly, verifying the output with the same verifiers the control
 * plane uses.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import type { CatalogForm } from "../../src/catalog/artifact";
import { CATALOG_FORMAT, parseForm, verifyArtifact } from "../../src/catalog/artifact";
import { MAX_NAME_LENGTH, MAX_SUMMARY_LENGTH } from "../../src/catalog/fields";
import { packArtifact } from "../../src/catalog/pack";
import type { DetachedSignature, TrustedCatalogKey } from "../../src/catalog/signature";
import { INDEX_SIGNING_DOMAIN, sha256Hex, signPayload } from "../../src/catalog/signature";

const KEY_ID = /^[A-Za-z0-9][\w.-]{0,63}$/u;
const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/u;
const LINE_BREAK = /[\r\n]/u;
const PEM_MARKER = /-----(?:BEGIN|END) PRIVATE KEY-----/gu;
const WHITESPACE = /\s+/gu;
const PEM_LINE = /.{1,64}/gu;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const requireKeyId = (keyId: string): string => {
    if (!KEY_ID.test(keyId)) {
        throw new Error(`key id ${JSON.stringify(keyId)} must be 1 to 64 letters, digits, dots, dashes or underscores`);
    }

    return keyId;
};

/** The parsed `[major, minor, patch]` of a version. Refuses anything that is not `major.minor.patch`. */
const parseSemver = (version: string): [number, number, number] => {
    const match = SEMVER.exec(version);

    if (match === null) {
        throw new Error(`version ${JSON.stringify(version)} is not semver (major.minor.patch)`);
    }

    return [Number(match[1]), Number(match[2]), Number(match[3])];
};

/** A single line of text within a length range; the catalog shows these in one line. */
const readLine = (record: Record<string, unknown>, field: string, min: number, max: number): string => {
    const value = record[field];

    if (typeof value !== "string" || value.length < min || value.length > max || LINE_BREAK.test(value)) {
        throw new Error(`${field} must be a single line of ${String(min)} to ${String(max)} characters`);
    }

    return value;
};

const toPem = (der: Uint8Array): string => {
    const body = Buffer.from(der).toString("base64").match(PEM_LINE)?.join("\n") ?? "";

    return `-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n`;
};

/** What the catalog shows for one app, and what its `app.json` declares for the manifest. */
export interface AppSpec {
    bindings?: unknown[];
    form?: CatalogForm;
    main: string;
    name: string;
    runtime?: "lunora" | "worker";
    slug: string;
    summary: string;
    version: string;
}

/** One app read from disk: its spec and the files of its `src/`, keyed by their path inside the archive. */
export interface AppSource {
    files: Record<string, Uint8Array>;
    spec: AppSpec;
}

/** One packed and signed release. */
export interface PackedRelease {
    archive: Uint8Array;
    manifestBytes: Uint8Array;
    signature: DetachedSignature;
    spec: AppSpec;
}

/** One entry of the index, as the control plane reads it. */
export interface IndexEntry {
    artifactUrl: string;
    manifestSha256: string;
    manifestUrl: string;
    name: string;
    signatureUrl: string;
    slug: string;
    summary?: string;
    version: string;
}

/** A complete, signed catalog: the listed releases (one per slug, its highest version) and the index over them. */
export interface PublishedCatalog {
    indexBytes: Uint8Array;
    indexSignature: DetachedSignature;
    releases: PackedRelease[];
}

export interface GeneratedKeyPair {
    keyId: string;
    /** PKCS8 PEM of the private key. Never printed; written to a file with mode 600. */
    privatePem: string;
    /** The JSON line `CATALOG_PUBLIC_KEYS` expects: `{"keyId","publicKey"}`. */
    publicLine: string;
}

export interface PublishInput {
    apps: AppSource[];
    baseUrl: string;
    keyId: string;
    /** The index's `issuedAt`. Defaults to the current time. */
    now?: Date;
    privateKey: CryptoKey;
}

/** Compare two `major.minor.patch` versions numerically. Refuses anything else. */
export const compareVersions = (left: string, right: string): number => {
    const a = parseSemver(left);
    const b = parseSemver(right);

    for (let index = 0; index < 3; index += 1) {
        if (a[index] !== b[index]) {
            return (a[index] ?? 0) - (b[index] ?? 0);
        }
    }

    return 0;
};

/**
 * Parse an `app.json`. Slug, version, main and bindings are checked when the release
 * is packed; this shapes the file and checks the catalog's display fields and the form.
 */
export const parseAppSpec = (value: unknown): AppSpec => {
    if (!isRecord(value)) {
        throw new Error("app.json must be a JSON object");
    }

    if (typeof value["slug"] !== "string" || typeof value["version"] !== "string") {
        throw new TypeError("slug and version must be strings");
    }

    if (typeof value["main"] !== "string") {
        throw new TypeError("main must be the path of the Worker entry module");
    }

    if (value["runtime"] !== undefined && value["runtime"] !== "lunora" && value["runtime"] !== "worker") {
        throw new Error("runtime must be lunora or worker");
    }

    if (value["bindings"] !== undefined && !Array.isArray(value["bindings"])) {
        throw new Error("bindings must be a list of binding entries");
    }

    let form: CatalogForm | undefined;

    if (value["form"] !== undefined) {
        const parsed = parseForm(value["form"]);

        if (!parsed.ok) {
            throw new Error(`form: ${parsed.error.message}`);
        }

        form = parsed.form;
    }

    return {
        ...(Array.isArray(value["bindings"]) ? { bindings: value["bindings"] } : {}),
        ...(form === undefined ? {} : { form }),
        main: value["main"],
        name: readLine(value, "name", 1, MAX_NAME_LENGTH),
        ...(value["runtime"] === undefined ? {} : { runtime: value["runtime"] }),
        slug: value["slug"],
        summary: readLine(value, "summary", 0, MAX_SUMMARY_LENGTH),
        version: value["version"],
    };
};

/** Every regular file under `root`, keyed by its forward-slash path relative to `root`. */
export const collectFiles = (root: string): Record<string, Uint8Array> => {
    const files: Record<string, Uint8Array> = {};

    const walk = (directory: string): void => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
            const full = join(directory, entry.name);

            if (entry.isDirectory()) {
                walk(full);
            } else if (entry.isFile()) {
                files[relative(root, full).split(sep).join("/")] = new Uint8Array(readFileSync(full));
            } else {
                throw new Error(`${full} is neither a file nor a directory; symlinks cannot be packed`);
            }
        }
    };

    walk(root);

    return files;
};

/** Read one app directory: its `app.json`, and its `src/` as the files of the release. */
export const readAppSource = (directory: string): AppSource => {
    const specPath = join(directory, "app.json");
    const sourceRoot = join(directory, "src");

    if (!existsSync(specPath)) {
        throw new Error(`${directory} has no app.json`);
    }

    if (!existsSync(sourceRoot) || !statSync(sourceRoot).isDirectory()) {
        throw new Error(`${directory} has no src/ directory`);
    }

    return { files: collectFiles(sourceRoot), spec: parseAppSpec(JSON.parse(readFileSync(specPath, "utf8"))) };
};

/** A fresh Ed25519 keypair: the public half as the `CATALOG_PUBLIC_KEYS` line, the private half as PEM. */
export const generateKeyPair = async (keyId: string): Promise<GeneratedKeyPair> => {
    requireKeyId(keyId);

    const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
    const publicKey = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey));
    const pkcs8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));

    return {
        keyId,
        privatePem: toPem(pkcs8),
        publicLine: JSON.stringify({ keyId, publicKey: Buffer.from(publicKey).toString("base64") }),
    };
};

/** Import a PKCS8 PEM Ed25519 private key. Extractable, so the publisher can derive its public half to check its own output. */
export const importPrivateKey = async (pem: string): Promise<CryptoKey> => {
    if (!pem.includes("BEGIN PRIVATE KEY")) {
        throw new Error("the key must be a PKCS8 PEM private key (BEGIN PRIVATE KEY)");
    }

    const body = pem.replaceAll(PEM_MARKER, "").replaceAll(WHITESPACE, "");

    return crypto.subtle.importKey("pkcs8", new Uint8Array(Buffer.from(body, "base64")), { name: "Ed25519" }, true, ["sign"]);
};

/** The public half of a private key, filed under `keyId`, for verifying what the key signed. */
export const trustedKeyOf = async (keyId: string, privateKey: CryptoKey): Promise<TrustedCatalogKey> => {
    const jwk = await crypto.subtle.exportKey("jwk", privateKey);

    if (typeof jwk.x !== "string") {
        throw new TypeError("the private key does not expose its public half");
    }

    return { keyId, publicKey: new Uint8Array(Buffer.from(jwk.x, "base64url")) };
};

/**
 * The base URL with its trailing slashes removed. Only `https` is accepted: an index
 * must not point installs at plain text.
 */
export const artifactBaseUrl = (baseUrl: string): string => {
    let url: URL;

    try {
        url = new URL(baseUrl);
    } catch {
        throw new Error(`base URL ${JSON.stringify(baseUrl)} is not a URL`);
    }

    if (url.protocol !== "https:") {
        throw new Error(`base URL ${baseUrl} must be https`);
    }

    let end = baseUrl.length;

    while (end > 0 && baseUrl[end - 1] === "/") {
        end -= 1;
    }

    return baseUrl.slice(0, end);
};

/** Pack and sign one app. Throws with the manifest rule's message when the inputs would not verify. */
export const packApp = async (input: { files: Record<string, Uint8Array>; keyId: string; privateKey: CryptoKey; spec: AppSpec }): Promise<PackedRelease> => {
    requireKeyId(input.keyId);

    const { spec } = input;
    const packed = await packArtifact({
        bindings: spec.bindings,
        files: input.files,
        form: spec.form,
        keyId: input.keyId,
        main: spec.main,
        privateKey: input.privateKey,
        runtime: spec.runtime,
        slug: spec.slug,
        version: spec.version,
    });

    return { ...packed, spec };
};

/**
 * Pack, verify and index every app, all in memory. Each release is verified with
 * the real artifact verifier under the public half of `privateKey` before anything
 * is listed. The index lists each slug at its highest version, and is signed under
 * its own domain tag. Nothing is returned unless every step succeeded, so a caller
 * that writes the result never writes a partial catalog.
 */
export const publishCatalog = async (input: PublishInput): Promise<PublishedCatalog> => {
    requireKeyId(input.keyId);

    const base = artifactBaseUrl(input.baseUrl);

    for (const app of input.apps) {
        parseSemver(app.spec.version);
    }

    const labels = input.apps.map((app) => `${app.spec.slug}@${app.spec.version}`);
    const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);

    if (duplicate !== undefined) {
        throw new Error(`${duplicate} is listed twice`);
    }

    const trusted = await trustedKeyOf(input.keyId, input.privateKey);
    const packed = await Promise.all(
        input.apps.map(async (app) => {
            const release = await packApp({ files: app.files, keyId: input.keyId, privateKey: input.privateKey, spec: app.spec });
            const verified = await verifyArtifact({
                archive: release.archive,
                keys: [trusted],
                manifestBytes: release.manifestBytes,
                signature: release.signature,
            });

            if (!verified.ok) {
                throw new Error(`${release.spec.slug}@${release.spec.version} does not verify: ${verified.error.message}`);
            }

            return release;
        }),
    );

    const latest = new Map<string, PackedRelease>();

    for (const release of packed) {
        const current = latest.get(release.spec.slug);

        if (current === undefined || compareVersions(release.spec.version, current.spec.version) > 0) {
            latest.set(release.spec.slug, release);
        }
    }

    const releases = [...latest.values()].toSorted((a, b) => a.spec.slug.localeCompare(b.spec.slug));
    const apps = await Promise.all(
        releases.map(async (release): Promise<IndexEntry> => {
            const { spec } = release;
            const stem = `${base}/${spec.slug}-${spec.version}`;

            return {
                artifactUrl: `${stem}.zip`,
                manifestSha256: await sha256Hex(release.manifestBytes),
                manifestUrl: `${stem}.manifest.json`,
                name: spec.name,
                signatureUrl: `${stem}.manifest.sig`,
                slug: spec.slug,
                ...(spec.summary === "" ? {} : { summary: spec.summary }),
                version: spec.version,
            };
        }),
    );

    const issuedAt = (input.now ?? new Date()).toISOString();
    const indexBytes = new TextEncoder().encode(JSON.stringify({ apps, format: CATALOG_FORMAT, issuedAt }));
    const indexSignature: DetachedSignature = {
        keyId: input.keyId,
        signature: await signPayload(input.privateKey, INDEX_SIGNING_DOMAIN, indexBytes),
    };

    return { indexBytes, indexSignature, releases };
};

/**
 * Write a published catalog flat into `directory`: each listed release as
 * `&lt;slug>-&lt;version>.zip`, `.manifest.json` and `.manifest.sig`, then `index.json` and
 * `index.sig`. Call it only with the result of `publishCatalog`.
 */
export const writeCatalog = (directory: string, catalog: PublishedCatalog): void => {
    mkdirSync(directory, { recursive: true });

    for (const release of catalog.releases) {
        const stem = join(directory, `${release.spec.slug}-${release.spec.version}`);

        writeFileSync(`${stem}.zip`, release.archive);
        writeFileSync(`${stem}.manifest.json`, release.manifestBytes);
        writeFileSync(`${stem}.manifest.sig`, `${JSON.stringify(release.signature)}\n`);
    }

    writeFileSync(join(directory, "index.json"), catalog.indexBytes);
    writeFileSync(join(directory, "index.sig"), `${JSON.stringify(catalog.indexSignature)}\n`);
};

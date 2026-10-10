/**
 * A signed catalog artifact: the prebuilt Worker a catalog's CI built and packed,
 * with a `manifest.json` that lists every file by sha256 and size, and a detached
 * signature over that manifest. Verification never trusts the archive: the
 * signature is checked first, then every file the manifest lists must be present
 * with its declared size and hash, and nothing unlisted may ride along.
 *
 * Installing one needs no build step here. The verified files go to the same
 * deploy core a CI-built release uses, so the control plane only ever verifies
 * and deploys.
 */
import { unzipSync } from "fflate";

import { isVersion, SHA256, SLUG } from "./fields";
import type { DetachedSignature, TrustedCatalogKey } from "./signature";
import { ARTIFACT_SIGNING_DOMAIN, sha256Hex, verifyDetached } from "./signature";

/** The manifest format this module reads. A later format is refused, not guessed at. */
export const CATALOG_FORMAT = 1;

/** Largest archive accepted, so a hostile one cannot exhaust the Worker's memory on decompression. */
export const MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;

/** Environment names a form may declare: upper snake case, and never the platform's own `LUNORA_` namespace. */
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/u;
const RESERVED_PREFIX = "LUNORA_";
const MAX_FORM_FIELDS = 64;
const MAX_DEFAULT_BYTES = 5 * 1024;

/** One file the artifact ships. */
export interface ArtifactFile {
    path: string;
    sha256: string;
    size: number;
}

/** A variable the install page asks for, or fills with its default. Becomes a Worker `var`. */
export interface FormVariable {
    default?: string;
    description?: string;
    label: string;
    name: string;
    required: boolean;
}

/** Secret generators the install can run instead of asking. */
export const SECRET_GENERATORS = ["base64-32", "hex-32"] as const;

export type SecretGenerator = (typeof SECRET_GENERATORS)[number];

/** A secret the install page asks for, or generates when the app declares a generator. Becomes a Worker secret. */
export interface FormSecret {
    description?: string;
    generate?: SecretGenerator;
    label: string;
    name: string;
    required: boolean;
}

/** The install form an app declares in its manifest: what the install page asks for. */
export interface CatalogForm {
    secrets: FormSecret[];
    vars: FormVariable[];
}

/** The manifest a catalog signs. `bindings` is passed through to the deploy manifest parser unchanged. */
export interface CatalogManifest {
    bindings?: unknown[];
    files: ArtifactFile[];
    /** What the install page asks for. Absent for an app with no configuration. */
    form?: CatalogForm;
    format: typeof CATALOG_FORMAT;
    /** The Worker entry module, one of `files`. */
    main: string;

    /**
     * `lunora` for a Lunora app (it binds `ShardDO`), `worker` for a plain Worker.
     * Absent means `worker`: a plain Worker is the safe default, since a Lunora
     * binding on a Worker that does not export `ShardDO` fails its upload.
     */
    runtime?: Runtime;
    slug: string;
    version: string;
}

/** Why an artifact was refused. */
export type ArtifactErrorCode =
    | "BAD_ARCHIVE"
    | "BAD_SIGNATURE"
    | "HASH_MISMATCH"
    | "INVALID_MANIFEST"
    | "MISSING_FILE"
    | "SIZE_MISMATCH"
    | "TOO_LARGE"
    | "UNKNOWN_KEY"
    | "UNLISTED_FILE"
    | "UNSUPPORTED_FORMAT";

export interface ArtifactError {
    code: ArtifactErrorCode;
    message: string;
}

/** A verified artifact: its manifest and the bytes of each listed file. */

const refuse = (code: ArtifactErrorCode, message: string): { error: ArtifactError; ok: false } => {
    return { error: { code, message }, ok: false };
};

/** A path inside the archive: relative, no traversal, no backslashes, no empty segments. */
const isSafePath = (path: string): boolean =>
    path.length > 0 &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    path.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");

/** A parsed form field, or the reason it is refused. */
type FieldResult<T> = { field: T; ok: true } | { error: ArtifactError; ok: false };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The entries of a form list. A present value that is not a list is refused, not dropped. */
const formList = (value: unknown, field: string): { items: unknown[]; ok: true } | { error: ArtifactError; ok: false } => {
    if (value === undefined) {
        return { items: [], ok: true };
    }

    if (!Array.isArray(value)) {
        return refuse("INVALID_MANIFEST", `form ${field} must be a list`);
    }

    return { items: value, ok: true };
};

/** A form name, claimed so that no other field may use it. */
const readFormName = (value: unknown, claimed: Set<string>): { name: string; ok: true } | { error: ArtifactError; ok: false } => {
    if (typeof value !== "string" || !ENV_NAME.test(value)) {
        return refuse("INVALID_MANIFEST", `form name ${String(value)} must be upper snake case`);
    }

    if (value.startsWith(RESERVED_PREFIX)) {
        return refuse("INVALID_MANIFEST", `form name ${value} is in the platform's ${RESERVED_PREFIX} namespace`);
    }

    if (claimed.has(value)) {
        return refuse("INVALID_MANIFEST", `form name ${value} is declared twice`);
    }

    claimed.add(value);

    return { name: value, ok: true };
};

/** A label is one line of 1 to 80 characters. */
const readLabel = (item: Record<string, unknown>, owner: string): { label: string; ok: true } | { error: ArtifactError; ok: false } => {
    const { label } = item;

    if (typeof label !== "string" || label.length === 0 || label.length > 80) {
        return refuse("INVALID_MANIFEST", `${owner} needs a label of 1 to 80 characters`);
    }

    return { label, ok: true };
};

const parseFormVariable = (entry: unknown, claimed: Set<string>): FieldResult<FormVariable> => {
    if (!isRecord(entry)) {
        return refuse("INVALID_MANIFEST", "each form var must be an object");
    }

    const named = readFormName(entry["name"], claimed);

    if (!named.ok) {
        return named;
    }

    const { name } = named;
    const labelled = readLabel(entry, `form var ${name}`);

    if (!labelled.ok) {
        return labelled;
    }

    const { default: fallback } = entry;

    if (fallback !== undefined && (typeof fallback !== "string" || new TextEncoder().encode(fallback).byteLength > MAX_DEFAULT_BYTES)) {
        return refuse("INVALID_MANIFEST", `form var ${name} default must be a string of at most ${String(MAX_DEFAULT_BYTES)} bytes`);
    }

    const { description } = entry;

    return {
        field: {
            ...(typeof fallback === "string" ? { default: fallback } : {}),
            ...(typeof description === "string" ? { description } : {}),
            label: labelled.label,
            name,
            required: entry["required"] === true,
        },
        ok: true,
    };
};

const parseFormSecret = (entry: unknown, claimed: Set<string>): FieldResult<FormSecret> => {
    if (!isRecord(entry)) {
        return refuse("INVALID_MANIFEST", "each form secret must be an object");
    }

    const named = readFormName(entry["name"], claimed);

    if (!named.ok) {
        return named;
    }

    const { name } = named;
    const labelled = readLabel(entry, `form secret ${name}`);

    if (!labelled.ok) {
        return labelled;
    }

    const { generate } = entry;

    if (generate !== undefined && !(SECRET_GENERATORS as ReadonlyArray<unknown>).includes(generate)) {
        return refuse("INVALID_MANIFEST", `form secret ${name} generate must be one of ${SECRET_GENERATORS.join(", ")}`);
    }

    const { description } = entry;

    return {
        field: {
            ...(typeof description === "string" ? { description } : {}),
            ...(generate === undefined ? {} : { generate: generate as SecretGenerator }),
            label: labelled.label,
            name,
            required: entry["required"] === true,
        },
        ok: true,
    };
};

/**
 * Parse the install form. Names are checked against the Worker env rules and the
 * platform's reserved prefix, and one name may appear only once across vars and
 * secrets, so the install can never write two values to the same binding.
 */
export const parseForm = (value: unknown): { form: CatalogForm; ok: true } | { error: ArtifactError; ok: false } => {
    if (!isRecord(value)) {
        return refuse("INVALID_MANIFEST", "form must be an object with vars and secrets lists");
    }

    const extra = Object.keys(value).filter((key) => key !== "vars" && key !== "secrets");

    if (extra.length > 0) {
        return refuse("INVALID_MANIFEST", `unknown form field(s): ${extra.join(", ")}`);
    }

    const variableList = formList(value["vars"], "vars");

    if (!variableList.ok) {
        return variableList;
    }

    const secretList = formList(value["secrets"], "secrets");

    if (!secretList.ok) {
        return secretList;
    }

    const claimed = new Set<string>();
    const variables: FormVariable[] = [];
    const secrets: FormSecret[] = [];

    for (const entry of variableList.items) {
        const parsed = parseFormVariable(entry, claimed);

        if (!parsed.ok) {
            return parsed;
        }

        variables.push(parsed.field);
    }

    for (const entry of secretList.items) {
        const parsed = parseFormSecret(entry, claimed);

        if (!parsed.ok) {
            return parsed;
        }

        secrets.push(parsed.field);
    }

    if (variables.length + secrets.length > MAX_FORM_FIELDS) {
        return refuse("INVALID_MANIFEST", `a form may declare at most ${String(MAX_FORM_FIELDS)} fields`);
    }

    return { form: { secrets, vars: variables }, ok: true };
};

/** One listed file: a safe path not listed before, a lowercase sha256 and a non-negative integer size. */
const parseFileEntry = (entry: unknown, seen: ReadonlySet<string>): FieldResult<ArtifactFile> => {
    if (!isRecord(entry)) {
        return refuse("INVALID_MANIFEST", "each listed file must be an object");
    }

    const { path, sha256, size } = entry;

    if (typeof path !== "string" || !isSafePath(path)) {
        return refuse("INVALID_MANIFEST", `file path ${String(path)} is not a safe relative path`);
    }

    if (seen.has(path)) {
        return refuse("INVALID_MANIFEST", `file ${path} is listed twice`);
    }

    if (typeof sha256 !== "string" || !SHA256.test(sha256)) {
        return refuse("INVALID_MANIFEST", `file ${path} needs a lowercase hex sha256`);
    }

    if (typeof size !== "number" || !Number.isSafeInteger(size) || size < 0) {
        return refuse("INVALID_MANIFEST", `file ${path} needs a non-negative integer size`);
    }

    return { field: { path, sha256, size }, ok: true };
};

/** The Worker runtimes a manifest may name. */
type Runtime = "lunora" | "worker";

const isRuntime = (value: unknown): value is Runtime => value === "lunora" || value === "worker";

/** The scalar fields of a manifest, each checked against what the publisher writes. The slug and version come back typed. */
const readHeader = (
    record: Record<string, unknown>,
): { error: ArtifactError; ok: false } | { bindings: unknown[] | undefined; ok: true; runtime: Runtime | undefined; slug: string; version: string } => {
    const known = new Set(["bindings", "files", "form", "format", "main", "runtime", "slug", "version"]);
    const unknown = Object.keys(record).filter((key) => !known.has(key));

    if (unknown.length > 0) {
        return refuse("INVALID_MANIFEST", `unknown manifest field(s): ${unknown.join(", ")}`);
    }

    if (record["format"] !== CATALOG_FORMAT) {
        return refuse(
            "UNSUPPORTED_FORMAT",
            `manifest format ${String(record["format"])} is not supported; this control plane reads format ${String(CATALOG_FORMAT)}`,
        );
    }

    if (record["bindings"] !== undefined && !Array.isArray(record["bindings"])) {
        return refuse("INVALID_MANIFEST", "bindings must be a list");
    }

    if (record["runtime"] !== undefined && !isRuntime(record["runtime"])) {
        return refuse("INVALID_MANIFEST", "runtime must be lunora or worker");
    }

    if (typeof record["slug"] !== "string" || !SLUG.test(record["slug"])) {
        return refuse("INVALID_MANIFEST", "slug must be lowercase letters, digits and hyphens, starting with a letter or digit");
    }

    if (!isVersion(record["version"])) {
        return refuse("INVALID_MANIFEST", "version must be a non-empty string of at most 64 characters");
    }

    return { bindings: record["bindings"], ok: true, runtime: record["runtime"], slug: record["slug"], version: record["version"] };
};

/**
 * Parse a manifest, refusing anything malformed. Returns the typed manifest or the
 * reason it is invalid; a field the schema does not know is refused too, so a
 * misspelled field fails loudly rather than being silently dropped.
 */
export const parseManifest = (value: unknown): { manifest: CatalogManifest; ok: true } | { error: ArtifactError; ok: false } => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return refuse("INVALID_MANIFEST", "the manifest is not a JSON object");
    }

    const record = value as Record<string, unknown>;
    const header = readHeader(record);

    if (!header.ok) {
        return header;
    }

    if (!Array.isArray(record["files"]) || record["files"].length === 0) {
        return refuse("INVALID_MANIFEST", "files must list at least the Worker entry module");
    }

    const files: ArtifactFile[] = [];
    const seen = new Set<string>();
    let total = 0;

    for (const entry of record["files"]) {
        const parsed = parseFileEntry(entry, seen);

        if (!parsed.ok) {
            return parsed;
        }

        total += parsed.field.size;
        seen.add(parsed.field.path);
        files.push(parsed.field);
    }

    if (total > MAX_ARTIFACT_BYTES) {
        return refuse("TOO_LARGE", `the listed files total ${String(total)} bytes, over the ${String(MAX_ARTIFACT_BYTES)}-byte limit`);
    }

    if (typeof record["main"] !== "string" || !seen.has(record["main"])) {
        return refuse("INVALID_MANIFEST", "main must name one of the listed files");
    }

    let form: CatalogForm | undefined;

    if (record["form"] !== undefined) {
        const parsedForm = parseForm(record["form"]);

        if (!parsedForm.ok) {
            return parsedForm;
        }

        form = parsedForm.form;
    }

    return {
        manifest: {
            ...(header.bindings === undefined ? {} : { bindings: header.bindings }),
            ...(form === undefined ? {} : { form }),
            ...(header.runtime === undefined ? {} : { runtime: header.runtime }),
            files,
            format: CATALOG_FORMAT,
            main: record["main"],
            slug: header.slug,
            version: header.version,
        },
        ok: true,
    };
};

/** The outcome of checking a manifest's signature and its contents. */
export type ManifestVerifyResult = { manifest: CatalogManifest; ok: true } | { error: ArtifactError; ok: false };

/**
 * Check a manifest: its signature under the artifact domain first, then the bytes
 * are parsed. Nothing in an unsigned manifest is read beyond the signature check.
 */
export const verifyManifestBytes = async (
    keys: TrustedCatalogKey[],
    manifestBytes: Uint8Array,
    signature: DetachedSignature,
): Promise<ManifestVerifyResult> => {
    const signed = await verifyDetached(keys, ARTIFACT_SIGNING_DOMAIN, manifestBytes, signature);

    if (!signed.ok) {
        return refuse(signed.code, signed.message);
    }

    let raw: unknown;

    try {
        raw = JSON.parse(new TextDecoder().decode(manifestBytes));
    } catch {
        return refuse("INVALID_MANIFEST", "the manifest is not valid JSON");
    }

    return parseManifest(raw);
};

/** The archive's files, each checked against the manifest. */
export type ArchiveVerifyResult = { files: Map<string, Uint8Array>; ok: true } | { error: ArtifactError; ok: false };

/**
 * Unpack an archive against a verified manifest. Only the files the manifest lists
 * are inflated, and only when their declared size matches, so a hostile archive
 * cannot expand past what the manifest allows. Every listed file must then match
 * its sha256, and nothing unlisted may be present.
 */
export const verifyArchive = async (archive: Uint8Array, manifest: CatalogManifest): Promise<ArchiveVerifyResult> => {
    if (archive.byteLength > MAX_ARTIFACT_BYTES) {
        return refuse("TOO_LARGE", `the archive is ${String(archive.byteLength)} bytes, over the ${String(MAX_ARTIFACT_BYTES)}-byte limit`);
    }

    const listed = new Map(manifest.files.map((file) => [file.path, file]));
    const unlisted: string[] = [];
    const wrongSize: string[] = [];
    let entries: Record<string, Uint8Array>;

    try {
        entries = unzipSync(archive, {
            filter: (file) => {
                const expected = listed.get(file.name);

                if (expected === undefined) {
                    unlisted.push(file.name);

                    return false;
                }

                if (file.originalSize !== expected.size) {
                    wrongSize.push(file.name);

                    return false;
                }

                return true;
            },
        });
    } catch {
        return refuse("BAD_ARCHIVE", "the archive is not a readable zip");
    }

    if (unlisted.length > 0) {
        return refuse("UNLISTED_FILE", `the archive holds files the manifest does not list: ${unlisted.join(", ")}`);
    }

    if (wrongSize.length > 0) {
        return refuse("SIZE_MISMATCH", `${wrongSize.join(", ")} does not match the size the manifest declares`);
    }

    const lookup = (path: string): Uint8Array | undefined => entries[path];

    // Hash every listed file at once, then report the first problem in manifest order.
    const hashed = await Promise.all(
        manifest.files.map(async (file) => {
            const bytes = lookup(file.path);

            return { bytes, digest: bytes === undefined ? undefined : await sha256Hex(bytes), file };
        }),
    );
    const files = new Map<string, Uint8Array>();

    for (const { bytes, digest, file } of hashed) {
        if (bytes === undefined) {
            return refuse("MISSING_FILE", `the archive is missing ${file.path}`);
        }

        if (digest !== file.sha256) {
            return refuse("HASH_MISMATCH", `${file.path} does not match its sha256`);
        }

        files.set(file.path, bytes);
    }

    return { files, ok: true };
};

export interface ArtifactInput {
    /** The archive bytes, as published (`&lt;slug>-&lt;version>.zip`). */
    archive: Uint8Array;
    keys: TrustedCatalogKey[];
    /** The manifest bytes exactly as signed, not a re-serialization. */
    manifestBytes: Uint8Array;
    signature: DetachedSignature;
}

/** A verified artifact: its manifest and the bytes of each listed file. */
export type ArtifactVerifyResult = { files: Map<string, Uint8Array>; manifest: CatalogManifest; ok: true } | { error: ArtifactError; ok: false };

/** Verify an artifact end to end: its manifest, then its archive. */
export const verifyArtifact = async (input: ArtifactInput): Promise<ArtifactVerifyResult> => {
    const manifest = await verifyManifestBytes(input.keys, input.manifestBytes, input.signature);

    if (!manifest.ok) {
        return manifest;
    }

    const archive = await verifyArchive(input.archive, manifest.manifest);

    if (!archive.ok) {
        return archive;
    }

    return { files: archive.files, manifest: manifest.manifest, ok: true };
};

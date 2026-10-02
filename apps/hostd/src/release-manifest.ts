/**
 * `@lunora/hostd/release` — the signed release manifest that tells a box which
 * `hostd`, celld and Caddy binaries make up one release (plan 458 W7, §9 Q2).
 *
 * A release is authenticated by an **Ed25519 signature over the manifest's
 * canonical bytes**, made with a maintainer key whose public half is pinned in
 * the `hostd` binary and in the control plane (`HOSTD_TRUSTED_RELEASE_KEYS`).
 * Each artifact is then authenticated by the SHA-256 and size the manifest
 * pins for it. GitHub artifact attestations add build provenance on top; a box
 * does not need them to verify a release.
 *
 * Zero runtime dependencies and no Node built-ins: the types, the validator
 * and the canonical encoding run unchanged in workerd, and so does the
 * signature check (`./release-signature`, on WebCrypto). Signing and file
 * hashing need `node:crypto`/`node:fs` and live in `@lunora/hostd/release/verify`.
 * The normative format, for implementations in any language, is §8 of
 * `protocol/hostd/README.md`.
 */
import { fail, InvalidField, readArray, readId, readInteger, readMatching, readObject, readString, VERSION_PATTERN } from "./wire/validate";

/** The manifest schema this module reads and writes. */
const HOSTD_RELEASE_SCHEMA = 1;

/** Domain tag that starts the signed bytes, so a release signature can never be replayed as anything else. */
const HOSTD_RELEASE_SIGNING_DOMAIN = "lunora-hostd-release:v1";

/** Platforms a release may ship. Every component of one release covers the same set. */
const HOSTD_RELEASE_PLATFORMS = ["linux-arm64", "linux-x64"] as const;

/** A platform a release ships for. */
type HostdReleasePlatform = (typeof HOSTD_RELEASE_PLATFORMS)[number];

/** One downloadable binary of a release component. */
interface HostdReleaseArtifact {
    /**
     * Present when the bytes at `url` are a gzip stream of the binary (celld
     * publishes one gzipped binary per target). `sha256` and `size` always describe the
     * bytes as downloaded, never the decompressed binary.
     */
    compression?: "gzip";
    platform: HostdReleasePlatform;
    /** Lowercase hex SHA-256 of the bytes at `url`. */
    sha256: string;
    /** Byte length of the bytes at `url`. */
    size: number;
    /** `https:` URL without credentials. */
    url: string;
}

/** One component of a release: a version and one artifact per platform. */
interface HostdReleaseComponent {
    artifacts: HostdReleaseArtifact[];
    version: string;
}

/** Caddy, plus the modules compiled into the pinned build. */
interface HostdReleaseCaddy extends HostdReleaseComponent {
    /** Go module paths compiled in, e.g. `github.com/mholt/caddy-ratelimit`. */
    modules: string[];
}

/**
 * Everything a box installs for one release. `hostd` and `caddy` artifacts are
 * built and hosted by Lunora (Caddy from pinned source, with its modules);
 * `celld` pins upstream release binaries by checksum.
 */
interface HostdReleaseManifest {
    caddy: HostdReleaseCaddy;
    celld: HostdReleaseComponent;
    /** UTC timestamp, `YYYY-MM-DDTHH:MM:SS[.sss]Z`. */
    createdAt: string;
    hostd: HostdReleaseComponent;
    /** The id an `upgrade` job names; same alphabet as every protocol id, `[A-Za-z0-9_-]{1,128}`. */
    releaseId: string;
    schema: typeof HOSTD_RELEASE_SCHEMA;
}

/** A manifest with its detached signature, as published next to the binaries (`manifest.json`). */
interface HostdReleaseEnvelope {
    /** Which trusted key signed it: `[A-Za-z0-9_.-]{1,64}`. */
    keyId: string;
    manifest: HostdReleaseManifest;
    /** Ed25519 over {@link releaseSigningPayload}, base64url without padding (86 characters). */
    signature: string;
}

/** Why a manifest or envelope was rejected. `path` is JSONPath-like: `$.hostd.artifacts[1].sha256`. */
interface ReleaseValidationError {
    message: string;
    path: string;
}

/** Outcome of validating untrusted input. Validation never throws. */
type ReleaseValidationResult<T> = { error: ReleaseValidationError; ok: false } | { ok: true; value: T };

const SHA256_PATTERN = /^[\da-f]{64}$/u;

const KEY_ID_PATTERN = /^[\w.-]{1,64}$/u;

const SIGNATURE_PATTERN = /^[\w-]{86}$/u;

const CREATED_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u;

/** A Go module path: a host, then one or more path segments. */
const MODULE_PATTERN = /^[a-z\d][\d.a-z-]*(?:\/[\w.~-]+)+$/u;

const MAX_MODULES = 16;

const MAX_MODULE_LENGTH = 256;

const MAX_URL_LENGTH = 2048;

/**
 * Printable ASCII without space, `"` or `\\`: a URL that needs no JSON escape,
 * so every string in a manifest serialises identically in any language.
 */
const URL_CHARACTERS_PATTERN = /^[\u0021\u0023-\u005B\u005D-\u007E]+$/u;

const PLATFORMS: ReadonlySet<string> = new Set<string>(HOSTD_RELEASE_PLATFORMS);

/** Whether `value` names a release platform. */
const isReleasePlatform = (value: string): value is HostdReleasePlatform => PLATFORMS.has(value);

/** The `component` artifact a manifest pins for `platform`, or `undefined` when it ships none. */
const releaseArtifactFor = (
    manifest: HostdReleaseManifest,
    component: "caddy" | "celld" | "hostd",
    platform: HostdReleasePlatform,
): HostdReleaseArtifact | undefined => manifest[component].artifacts.find((artifact) => artifact.platform === platform);

const readHttpsUrl = (value: unknown, path: string): string => {
    const text = readString(value, path);

    if (text.length > MAX_URL_LENGTH || !URL.canParse(text)) {
        return fail(path, `must be an absolute URL of at most ${String(MAX_URL_LENGTH)} characters`);
    }

    if (!URL_CHARACTERS_PATTERN.test(text)) {
        fail(path, "must be printable ASCII without spaces, quotes or backslashes");
    }

    const url = new URL(text);

    if (url.protocol !== "https:") {
        fail(path, "must be an https URL");
    }

    if (url.username !== "" || url.password !== "") {
        fail(path, "must not carry credentials");
    }

    return text;
};

const readVersion = (value: unknown, path: string): string => readMatching(value, path, VERSION_PATTERN, "1-64 characters of [A-Za-z0-9_.+~-]");

const readArtifact = (value: unknown, path: string): HostdReleaseArtifact => {
    const record = readObject(value, path, ["platform", "url", "sha256", "size"], ["compression"]);
    const platform = readString(record.platform, `${path}.platform`);

    if (!PLATFORMS.has(platform)) {
        fail(`${path}.platform`, `must be one of ${HOSTD_RELEASE_PLATFORMS.join(", ")}`);
    }

    const artifact: HostdReleaseArtifact = {
        platform: platform as HostdReleasePlatform,
        sha256: readMatching(record.sha256, `${path}.sha256`, SHA256_PATTERN, "64 lowercase hex digits"),
        size: readInteger(record.size, `${path}.size`, 1),
        url: readHttpsUrl(record.url, `${path}.url`),
    };

    if (record.compression !== undefined) {
        if (record.compression !== "gzip") {
            fail(`${path}.compression`, 'must be "gzip" when present');
        }

        artifact.compression = "gzip";
    }

    return artifact;
};

/** Reads a component's artifacts: 1 per platform at most, platforms unique. */
const readArtifacts = (value: unknown, path: string): HostdReleaseArtifact[] => {
    const artifacts = readArray(value, path, HOSTD_RELEASE_PLATFORMS.length).map((entry, index) => readArtifact(entry, `${path}[${String(index)}]`));

    if (artifacts.length === 0) {
        fail(path, "must list at least one artifact");
    }

    const seen = new Set<string>();

    for (const [index, artifact] of artifacts.entries()) {
        if (seen.has(artifact.platform)) {
            fail(`${path}[${String(index)}].platform`, `repeats ${JSON.stringify(artifact.platform)}`);
        }

        seen.add(artifact.platform);
    }

    return artifacts;
};

const readComponent = (value: unknown, path: string): HostdReleaseComponent => {
    const record = readObject(value, path, ["version", "artifacts"]);

    return { artifacts: readArtifacts(record.artifacts, `${path}.artifacts`), version: readVersion(record.version, `${path}.version`) };
};

const readCaddy = (value: unknown, path: string): HostdReleaseCaddy => {
    const record = readObject(value, path, ["version", "modules", "artifacts"]);
    const modules = readArray(record.modules, `${path}.modules`, MAX_MODULES).map((entry, index) => {
        const modulePath = `${path}.modules[${String(index)}]`;
        const text = readMatching(entry, modulePath, MODULE_PATTERN, "a Go module path such as github.com/mholt/caddy-ratelimit");

        if (text.length > MAX_MODULE_LENGTH) {
            fail(modulePath, `must be at most ${String(MAX_MODULE_LENGTH)} characters`);
        }

        return text;
    });

    if (new Set(modules).size !== modules.length) {
        fail(`${path}.modules`, "must not repeat a module");
    }

    return {
        artifacts: readArtifacts(record.artifacts, `${path}.artifacts`),
        modules,
        version: readVersion(record.version, `${path}.version`),
    };
};

const readCreatedAt = (value: unknown, path: string): string => {
    const text = readMatching(value, path, CREATED_AT_PATTERN, "a UTC timestamp YYYY-MM-DDTHH:MM:SS[.sss]Z");

    // The pattern admits 2026-13-45; a real date must also round-trip through Date.
    const parsed = new Date(text);

    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 19) !== text.slice(0, 19)) {
        fail(path, "must be a real UTC date and time");
    }

    return text;
};

/**
 * Orders strings by UTF-16 code unit, which for the ASCII keys and platform
 * names in a manifest is byte order. Never `localeCompare`: the canonical
 * bytes must not depend on the signer's locale.
 */
const byCodeUnit = (left: string, right: string): number => {
    if (left < right) {
        return -1;
    }

    return left > right ? 1 : 0;
};

const platformsOf = (component: HostdReleaseComponent): string =>
    component.artifacts
        .map((artifact) => artifact.platform)
        .toSorted(byCodeUnit)
        .join(",");

const readManifest = (value: unknown, path: string): HostdReleaseManifest => {
    const record = readObject(value, path, ["schema", "releaseId", "createdAt", "hostd", "celld", "caddy"]);

    if (record.schema !== HOSTD_RELEASE_SCHEMA) {
        fail(`${path}.schema`, `must be ${String(HOSTD_RELEASE_SCHEMA)}`);
    }

    const manifest: HostdReleaseManifest = {
        caddy: readCaddy(record.caddy, `${path}.caddy`),
        celld: readComponent(record.celld, `${path}.celld`),
        createdAt: readCreatedAt(record.createdAt, `${path}.createdAt`),
        hostd: readComponent(record.hostd, `${path}.hostd`),
        releaseId: readId(record.releaseId, `${path}.releaseId`),
        schema: HOSTD_RELEASE_SCHEMA,
    };

    // A box installs all three for its own platform, so a platform one component
    // lacks would leave that box half-upgraded.
    const hostdPlatforms = platformsOf(manifest.hostd);

    for (const name of ["celld", "caddy"] as const) {
        if (platformsOf(manifest[name]) !== hostdPlatforms) {
            fail(`${path}.${name}.artifacts`, `must cover the same platforms as hostd (${hostdPlatforms})`);
        }
    }

    return manifest;
};

const readEnvelope = (value: unknown, path: string): HostdReleaseEnvelope => {
    const record = readObject(value, path, ["manifest", "signature", "keyId"]);

    return {
        keyId: readMatching(record.keyId, `${path}.keyId`, KEY_ID_PATTERN, "1-64 characters of [A-Za-z0-9_.-]"),
        manifest: readManifest(record.manifest, `${path}.manifest`),
        signature: readMatching(record.signature, `${path}.signature`, SIGNATURE_PATTERN, "an Ed25519 signature: 86 base64url characters"),
    };
};

const validateWith = <T>(read: (value: unknown, path: string) => T, value: unknown): ReleaseValidationResult<T> => {
    try {
        return { ok: true, value: read(value, "$") };
    } catch (error: unknown) {
        if (error instanceof InvalidField) {
            return { error: { message: error.message, path: error.path }, ok: false };
        }

        throw error;
    }
};

/**
 * Strictly validates an untrusted release manifest. Rejects unknown fields at
 * every level, non-`https:` URLs, URLs with credentials, malformed checksums
 * and components that do not cover the same platforms. Never throws.
 * @returns a fresh manifest holding only the known fields, or why it was rejected
 */
const validateReleaseManifest = (value: unknown): ReleaseValidationResult<HostdReleaseManifest> => validateWith(readManifest, value);

/**
 * Strictly validates an untrusted signed envelope (`manifest.json`): the
 * manifest as {@link validateReleaseManifest} does, plus the key id and the
 * signature's shape. It does NOT check the signature; that is
 * `verifyReleaseManifest`. Never throws.
 */
const validateReleaseEnvelope = (value: unknown): ReleaseValidationResult<HostdReleaseEnvelope> => validateWith(readEnvelope, value);

/** Canonical JSON: object keys sorted, no whitespace. Only strings, safe integers, arrays and plain objects occur in a manifest. */
const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) {
        return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
    }

    if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        const keys = Object.keys(record)
            .filter((key) => record[key] !== undefined)
            .toSorted(byCodeUnit);

        return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
    }

    if (typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value))) {
        return JSON.stringify(value);
    }

    throw new TypeError(`a release manifest holds only strings, safe integers, arrays and objects, not ${typeof value}`);
};

const utf8 = new TextEncoder();

/** Validates, then returns the manifest's own copy; throws a `TypeError` naming the bad field. */
const checkedManifest = (manifest: HostdReleaseManifest): HostdReleaseManifest => {
    const result = validateReleaseManifest(manifest);

    if (!result.ok) {
        throw new TypeError(`invalid release manifest: ${result.error.message}`);
    }

    return result.value;
};

/**
 * The manifest's canonical encoding: UTF-8 JSON with every object's keys
 * sorted by code unit (all keys are ASCII, so this is byte order), no
 * whitespace, array order kept. Two manifests that differ only in key order
 * encode identically.
 * @throws {TypeError} when the manifest is invalid; only a valid manifest has a canonical form.
 */
const canonicalManifestBytes = (manifest: HostdReleaseManifest): Uint8Array => utf8.encode(canonicalJson(checkedManifest(manifest)));

/**
 * The exact bytes a release signature covers: `lunora-hostd-release:v1`, a
 * newline (0x0A), then {@link canonicalManifestBytes}. The domain tag keeps a
 * release signature from ever verifying as some other signed object.
 * @throws {TypeError} when the manifest is invalid.
 */
const releaseSigningPayload = (manifest: HostdReleaseManifest): Uint8Array =>
    utf8.encode(`${HOSTD_RELEASE_SIGNING_DOMAIN}\n${canonicalJson(checkedManifest(manifest))}`);

export type {
    HostdReleaseArtifact,
    HostdReleaseCaddy,
    HostdReleaseComponent,
    HostdReleaseEnvelope,
    HostdReleaseManifest,
    HostdReleasePlatform,
    ReleaseValidationError,
    ReleaseValidationResult,
};
export {
    canonicalManifestBytes,
    HOSTD_RELEASE_PLATFORMS,
    HOSTD_RELEASE_SCHEMA,
    HOSTD_RELEASE_SIGNING_DOMAIN,
    isReleasePlatform,
    releaseArtifactFor,
    releaseSigningPayload,
    validateReleaseEnvelope,
    validateReleaseManifest,
};

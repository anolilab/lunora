/**
 * `lunora-hostd`'s on-disk configuration (plan 458 W4): where the control plane
 * is, who this box is, where its key, bucket and data live, and which ports
 * and binaries it may use. Written once by `lunora-hostd enrol`, read by every
 * other command.
 *
 * Secrets never sit in this file. The box's private key is its own file
 * (`keyFile`, mode 0600) and the bucket credentials are an environment file
 * (`credentialsFile`, mode 0600) that only the fleets' environment reads —
 * neither ever reaches the control plane (plan 458 §3 rule 5).
 */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

import { isRecord, optional } from "../values";
import { isProtocolId } from "../wire/validate";

/** Where the configuration lives unless `--config` or `LUNORA_HOSTD_CONFIG` says otherwise. */
const DEFAULT_CONFIG_PATH = "/etc/lunora-hostd/config.json";

/** Where fleets, releases and state live by default. */
const DEFAULT_DATA_DIR = "/var/lib/lunora-hostd";

/** Where `install.sh` and `upgrade` put each release's binaries (`{installDir}/{releaseId}/`) and the `current` link. */
const DEFAULT_INSTALL_DIR = "/opt/lunora-hostd";

/** The link in the install directory naming the release that runs. */
const CURRENT_RELEASE_LINK = "current";

/** The file name of each binary inside a release directory. */
const RELEASE_BINARY_NAMES = { caddy: "caddy", celld: "celld", hostd: "lunora-hostd" } as const;

/** The user every fleet runs as (plan 458 W8); `install.sh` creates it, with no shell and no home. */
const DEFAULT_FLEET_USER = "lunora-fleet";

/** The ports fleets are given from by default: two per fleet (public and internal), all on loopback. */
const DEFAULT_PORTS = { first: 20_000, last: 20_999 } as const;

/** The bucket credentials a fleet may be handed from the credentials file; nothing else in it is read. */
const CREDENTIAL_NAMES = ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"] as const;

/** The customer's bucket (plan 458 D7). Each fleet lives under `fleets/{alias}/` in it. */
interface BucketConfig {
    /** S3-compatible endpoint; absent for AWS S3 itself. */
    endpoint?: string;
    /** The bucket's name, without a scheme. */
    name: string;
    region?: string;
}

/** The box's edge: Caddy, its admin API and hostd's on-demand-TLS `ask` endpoint. */
interface CaddyConfig {
    /** Caddy's admin API, loopback only (`127.0.0.1:2019`). */
    adminAddress: string;
    /** Where hostd serves Caddy's on-demand-TLS permission check, loopback only. */
    askAddress: string;
    httpPort: number;
    httpsPort: number;
    /** Off only for test and development boxes: serve plain HTTP and request no certificates. */
    tls: boolean;
}

/** The binaries the box runs: always those of the `current` release in the install directory. */
interface BinaryPaths {
    caddy: string;
    celld: string;
    hostd: string;
}

interface HostdConfig {
    /** Run as root anyway. Off by default: hostd runs as its own user, and fleets (W8) as `lunora-fleet`. */
    allowRoot: boolean;
    boxId: string;
    bucket: BucketConfig;
    caddy: CaddyConfig;
    /** The control plane's origin (`https://…`), the only one this box signs requests for or takes jobs from. */
    controlPlane: string;
    /** The environment file holding the bucket credentials, mode 0600. */
    credentialsFile: string;
    dataDir: string;
    /** Each fleet's cgroup `memory.max`, in MiB. Absent: the box's memory less a reserve for hostd, Caddy and the system. */
    fleetMemoryMaxMb?: number;
    /** The user fleets run as (W8). */
    fleetUser: string;
    /** The box's own hostname, `{slug}.{box domain}`: its aliases answer under it. */
    hostname: string;
    /** Where the releases live: `{installDir}/{releaseId}/` each, `{installDir}/current` the one that runs. */
    installDir: string;
    /** The box's Ed25519 private key (PKCS#8 PEM), mode 0600. */
    keyFile: string;
    ports: { first: number; last: number };
    /** Enrolled with `--single-trust`: fleets may start without the W8 isolation self-check. */
    singleTrust: boolean;
}

/** Where `lunora-hostd` reads its configuration: `--config`, then `LUNORA_HOSTD_CONFIG`, then the default. */
const configPathOf = (flag: string | undefined, environment: NodeJS.ProcessEnv): string => flag ?? environment["LUNORA_HOSTD_CONFIG"] ?? DEFAULT_CONFIG_PATH;

/** A config problem worth showing the operator as it is. */
class ConfigError extends Error {
    public constructor(message: string) {
        super(message);
        this.name = "ConfigError";
    }
}

const LINE_BREAK = /\r?\n/u;

/** A file's permission bits (the low nine bits of its mode), as `ls` prints them in octal. */
const permissionsOf = (mode: number): number => mode % 0o1000;

/** Whether a file with `mode` grants its group or others anything (any of the low six permission bits). */
const isOpenToOthers = (mode: number): boolean => permissionsOf(mode) % 0o100 !== 0;

const readField = <T>(record: Record<string, unknown>, key: string, check: (value: unknown) => value is T, what: string, path: string): T => {
    const value = record[key];

    if (!check(value)) {
        throw new ConfigError(`${path}.${key} must be ${what}`);
    }

    return value;
};

const isString = (value: unknown): value is string => typeof value === "string" && value !== "";

const isAbsolutePath = (value: unknown): value is string => isString(value) && isAbsolute(value);

const isBoolean = (value: unknown): value is boolean => typeof value === "boolean";

const USER_NAME_PATTERN = /^[a-z_][\w-]{0,31}$/u;

const isUserName = (value: unknown): value is string => typeof value === "string" && USER_NAME_PATTERN.test(value);

const isOptionalMemoryMb = (value: unknown): value is number | undefined =>
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 64);

const isPort = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 65_535;

const LOOPBACK_ADDRESS_PATTERN = /^127\.0\.0\.1:\d{1,5}$/u;

const isLoopbackAddress = (value: unknown): value is string => isString(value) && LOOPBACK_ADDRESS_PATTERN.test(value);

/** An `http:`/`https:` origin with nothing after it. */
const isOrigin = (value: unknown): value is string => {
    if (!isString(value)) {
        return false;
    }

    try {
        const url = new URL(value);

        return (url.protocol === "https:" || url.protocol === "http:") && url.origin === value;
    } catch {
        return false;
    }
};

const isOptionalString = (value: unknown): value is string | undefined => value === undefined || isString(value);

/** `record[key]` checked, or `fallback` when it is absent. */
const readOr = <T>(record: Record<string, unknown>, key: string, fallback: T, check: (value: unknown) => value is T, what: string, path: string): T =>
    record[key] === undefined ? fallback : readField(record, key, check, what, path);

const readCaddy = (raw: Record<string, unknown>): CaddyConfig => {
    const caddy = readOr(raw, "caddy", {}, isRecord, "an object", "$");

    return {
        adminAddress: readOr(caddy, "adminAddress", "127.0.0.1:2019", isLoopbackAddress, "127.0.0.1:{port}", "$.caddy"),
        askAddress: readOr(caddy, "askAddress", "127.0.0.1:2020", isLoopbackAddress, "127.0.0.1:{port}", "$.caddy"),
        httpPort: readOr(caddy, "httpPort", 80, isPort, "a port", "$.caddy"),
        httpsPort: readOr(caddy, "httpsPort", 443, isPort, "a port", "$.caddy"),
        tls: readOr(caddy, "tls", true, isBoolean, "a boolean", "$.caddy"),
    };
};

const readPorts = (raw: Record<string, unknown>): { first: number; last: number } => {
    const ports = readOr<Record<string, unknown>>(raw, "ports", DEFAULT_PORTS, isRecord, "an object", "$");
    const first = readField(ports, "first", isPort, "a port", "$.ports");
    const last = readField(ports, "last", isPort, "a port", "$.ports");

    if (last <= first) {
        throw new ConfigError("$.ports.last must be above $.ports.first: each fleet takes two ports");
    }

    return { first, last };
};

/**
 * Validate a parsed configuration, filling the defaults a hand-written file may leave out.
 * @throws {ConfigError} naming the first field that is wrong.
 */
const parseHostdConfig = (raw: unknown): HostdConfig => {
    if (!isRecord(raw)) {
        throw new ConfigError("the configuration must be a JSON object");
    }

    const dataDirectory = readOr(raw, "dataDir", DEFAULT_DATA_DIR, isAbsolutePath, "an absolute path", "$");
    const bucket = readField(raw, "bucket", isRecord, "an object", "$");

    return {
        allowRoot: readOr(raw, "allowRoot", false, isBoolean, "a boolean", "$"),
        boxId: readField(raw, "boxId", isProtocolId, "a box id", "$"),
        bucket: {
            name: readField(bucket, "name", isString, "a bucket name", "$.bucket"),
            ...optional("endpoint", readField(bucket, "endpoint", isOptionalString, "a URL", "$.bucket")),
            ...optional("region", readField(bucket, "region", isOptionalString, "a region", "$.bucket")),
        },
        caddy: readCaddy(raw),
        controlPlane: readField(raw, "controlPlane", isOrigin, "an http(s) origin with no path", "$"),
        credentialsFile: readField(raw, "credentialsFile", isAbsolutePath, "an absolute path", "$"),
        dataDir: dataDirectory,
        ...optional("fleetMemoryMaxMb", readField(raw, "fleetMemoryMaxMb", isOptionalMemoryMb, "a whole number of MiB, at least 64", "$")),
        fleetUser: readOr(raw, "fleetUser", DEFAULT_FLEET_USER, isUserName, "a user name", "$"),
        hostname: readField(raw, "hostname", isString, "the box's hostname", "$"),
        installDir: readOr(raw, "installDir", DEFAULT_INSTALL_DIR, isAbsolutePath, "an absolute path", "$"),
        keyFile: readField(raw, "keyFile", isAbsolutePath, "an absolute path", "$"),
        ports: readPorts(raw),
        singleTrust: readOr(raw, "singleTrust", false, isBoolean, "a boolean", "$"),
    };
};

/**
 * Read and validate the configuration at `path`.
 * @throws {ConfigError} when it is missing, not JSON, or invalid.
 */
const loadHostdConfig = (path: string): HostdConfig => {
    let text: string;

    try {
        text = readFileSync(path, "utf8");
    } catch {
        throw new ConfigError(`no configuration at ${path}: enrol this box first (lunora-hostd enrol --token …)`);
    }

    try {
        return parseHostdConfig(JSON.parse(text));
    } catch (error) {
        if (error instanceof ConfigError) {
            throw new ConfigError(`${path}: ${error.message}`);
        }

        throw new ConfigError(`${path} is not valid JSON`);
    }
};

/** Write `contents` to `path` atomically (temp file + rename) with `mode`, creating the directory. */
const writeFileAtomic = (path: string, contents: string, mode: number): void => {
    mkdirSync(dirname(path), { mode: 0o750, recursive: true });

    const temporary = `${path}.${String(process.pid)}.tmp`;

    writeFileSync(temporary, contents, { mode });
    // `mode` is masked by the umask on create; set it outright.
    chmodSync(temporary, mode);
    renameSync(temporary, path);
};

/** Write the configuration (mode 0640: it names paths and ids, never a secret). */
const saveHostdConfig = (path: string, config: HostdConfig): void => {
    writeFileAtomic(path, `${JSON.stringify(config, undefined, 4)}\n`, 0o640);
};

/** `KEY=value` lines; blank lines and `#` comments skipped. Values are taken verbatim. */
const parseEnvironmentFile = (text: string): Record<string, string> => {
    const entries: Record<string, string> = {};

    for (const line of text.split(LINE_BREAK)) {
        const trimmed = line.trim();
        const separator = trimmed.indexOf("=");

        if (trimmed === "" || trimmed.startsWith("#") || separator < 1) {
            continue;
        }

        entries[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
    }

    return entries;
};

/**
 * The bucket credentials from the credentials file — only the names celld's
 * AWS chain reads. A file others can read is refused: it holds the keys to the
 * customer's data.
 * @throws {ConfigError} when the file is readable by group or others.
 */
const loadBucketCredentials = (path: string): Record<string, string> => {
    let mode: number;

    try {
        mode = statSync(path).mode;
    } catch {
        // No file: the AWS chain finds credentials elsewhere (an instance role, say).
        return {};
    }

    if (isOpenToOthers(mode)) {
        throw new ConfigError(`${path} is readable by others (mode ${permissionsOf(mode).toString(8)}); chmod 600 it`);
    }

    const entries = parseEnvironmentFile(readFileSync(path, "utf8"));

    return Object.fromEntries(CREDENTIAL_NAMES.flatMap((name) => (entries[name] === undefined ? [] : [[name, entries[name]]])));
};

/** Write the bucket credentials file, mode 0600. */
const saveBucketCredentials = (path: string, credentials: Readonly<Record<string, string>>): void => {
    const lines = CREDENTIAL_NAMES.flatMap((name) => (credentials[name] === undefined ? [] : [`${name}=${credentials[name]}`]));

    writeFileAtomic(path, `# lunora-hostd bucket credentials — never shared with Lunora Cloud\n${lines.join("\n")}\n`, 0o600);
};

/** The binaries of the release `{installDir}/current` names. */
const binaryPaths = (config: Pick<HostdConfig, "installDir">): BinaryPaths => {
    const current = join(config.installDir, CURRENT_RELEASE_LINK);

    return {
        caddy: join(current, RELEASE_BINARY_NAMES.caddy),
        celld: join(current, RELEASE_BINARY_NAMES.celld),
        hostd: join(current, RELEASE_BINARY_NAMES.hostd),
    };
};

/** The bucket prefix a fleet's objects live under, with its trailing slash dropped. */
const fleetPrefix = (alias: string): string => `fleets/${alias}`;

/** `s3://{bucket}/fleets/{alias}`: the fleet's own prefix of the customer's bucket (plan 458 D8). */
const fleetBucketUrl = (bucket: BucketConfig, alias: string): string => `s3://${bucket.name}/${fleetPrefix(alias)}`;

export type { BinaryPaths, BucketConfig, CaddyConfig, HostdConfig };
export {
    binaryPaths,
    ConfigError,
    configPathOf,
    CREDENTIAL_NAMES,
    CURRENT_RELEASE_LINK,
    DEFAULT_CONFIG_PATH,
    DEFAULT_DATA_DIR,
    DEFAULT_FLEET_USER,
    DEFAULT_INSTALL_DIR,
    DEFAULT_PORTS,
    fleetBucketUrl,
    fleetPrefix,
    isOpenToOthers,
    loadBucketCredentials,
    loadHostdConfig,
    parseEnvironmentFile,
    parseHostdConfig,
    permissionsOf,
    RELEASE_BINARY_NAMES,
    saveBucketCredentials,
    saveHostdConfig,
    writeFileAtomic,
};

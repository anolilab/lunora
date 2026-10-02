/**
 * Hand-written, strict validators for every hostd message.
 *
 * Zero dependencies, so the same code runs in `hostd` (Node) and in the
 * control plane's Durable Object (workerd). Each reader takes an untrusted
 * value and returns a FRESH object holding only the known fields, so nothing a
 * peer smuggles in survives validation. Readers throw {@link InvalidField};
 * the codec turns that into a `DecodeResult` and never lets it escape.
 */
import { HOSTD_PROTOCOL_LIMITS } from "./constants";
import type {
    AliasReport,
    AuthMessage,
    BoxIsolation,
    BoxMessage,
    BoxResources,
    BoxVersions,
    ChallengeMessage,
    CloudErrorMessage,
    CloudMessage,
    DeployJob,
    DestroyJob,
    DiagnoseJob,
    FleetState,
    FleetSummary,
    HelloMessage,
    HostdJob,
    IsolationStatus,
    JobMessage,
    PingMessage,
    PongMessage,
    ProgressMessage,
    ProtocolErrorDetail,
    ReloadJob,
    ReportMessage,
    ResultMessage,
    RouteEntry,
    RoutesMessage,
    UpgradeJob,
} from "./types";

/** A field failed validation. Internal: the codec converts it into a `DecodeError`. */
class InvalidField extends Error {
    public readonly path: string;

    public constructor(path: string, message: string) {
        super(`${path} ${message}`);
        this.name = "InvalidField";
        this.path = path;
    }
}

const fail = (path: string, message: string): never => {
    throw new InvalidField(path, message);
};

const utf8 = new TextEncoder();

/** UTF-8 byte length of a string. */
const utf8ByteLength = (value: string): number => utf8.encode(value).byteLength;

/**
 * A deployment alias: dash-separated runs of `[a-z0-9]`, so it never contains
 * `--`. The one definition — `apps/cloud` imports {@link isAlias} from here
 * (the dependency may only run cloud → hostd).
 */
const ALIAS_PATTERN = /^[a-z\d]+(?:-[a-z\d]+)*$/u;

/** Box, job, deployment and release ids: URL-safe, never containing `:` or a newline, so they cannot break a signing payload. */
const ID_PATTERN = /^[\w-]{1,128}$/u;

/** base64url without padding. */
const BASE64URL_PATTERN = /^[\w-]+$/u;

/** An Ed25519 signature is 64 bytes: 86 base64url characters without padding. */
const SIGNATURE_LENGTH = 86;

/** A challenge nonce carries at least 128 bits (22 base64url characters). */
const MIN_NONCE_LENGTH = 22;

const MAX_NONCE_LENGTH = 128;

/** One DNS label: lowercase letters, digits and inner hyphens, at most 63 characters. */
const HOSTNAME_LABEL_PATTERN = /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/u;

const MAX_HOSTNAME_LENGTH = 253;

/** A final label of only digits would make the hostname an IPv4 address. */
const ALL_DIGITS_PATTERN = /^\d+$/u;

/** Version strings are displayed, never parsed: semver-ish characters only (`v2.8.4`, `1.0.0-alpha.1+abc`). */
const VERSION_PATTERN: RegExp = /^[\w.+~-]{1,64}$/u;

/** Upper-snake-case error codes. */
const ERROR_CODE_PATTERN = /^[A-Z][A-Z\d_]{0,63}$/u;

/** Var names: environment-variable shaped. */
const VAR_NAME_PATTERN = /^[A-Z_a-z]\w{0,255}$/u;

const COMPATIBILITY_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/u;

const MAX_CRON_LENGTH = 256;

const FLEET_STATES: ReadonlySet<string> = new Set<FleetState>(["failed", "running", "starting", "stopped"]);

const ISOLATION_STATUSES: ReadonlySet<string> = new Set<IsolationStatus>(["enforced", "refused", "single-trust"]);

const readObject = (value: unknown, path: string, required: ReadonlyArray<string>, optional: ReadonlyArray<string> = []): Record<string, unknown> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, "must be an object");
    }

    const record = value as Record<string, unknown>;

    for (const key of Object.keys(record)) {
        if (!required.includes(key) && !optional.includes(key)) {
            fail(`${path}.${key}`, "is not a known field");
        }
    }

    for (const key of required) {
        if (record[key] === undefined) {
            fail(`${path}.${key}`, "is required");
        }
    }

    return record;
};

const readArray = (value: unknown, path: string, max: number): unknown[] => {
    if (!Array.isArray(value)) {
        return fail(path, "must be an array");
    }

    if (value.length > max) {
        fail(path, `must have at most ${String(max)} entries`);
    }

    return value as unknown[];
};

const readBoolean = (value: unknown, path: string): boolean => {
    if (typeof value !== "boolean") {
        return fail(path, "must be a boolean");
    }

    return value;
};

/** A non-negative safe integer, at least `min`. */
const readInteger = (value: unknown, path: string, min = 0): number => {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
        return fail(path, `must be an integer >= ${String(min)}`);
    }

    return value;
};

const readNonNegativeNumber = (value: unknown, path: string): number => {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
        return fail(path, "must be a finite number >= 0");
    }

    return value;
};

const readString = (value: unknown, path: string): string => {
    if (typeof value !== "string") {
        return fail(path, "must be a string");
    }

    return value;
};

const readMatching = (value: unknown, path: string, pattern: RegExp, description: string): string => {
    const text = readString(value, path);

    if (!pattern.test(text)) {
        fail(path, `must be ${description}`);
    }

    return text;
};

/** A string of at most `maxBytes` UTF-8 bytes. */
const readText = (value: unknown, path: string, maxBytes: number): string => {
    const text = readString(value, path);

    // A string never encodes to fewer UTF-8 bytes than it has UTF-16 code units,
    // so the length check rejects an oversize string without encoding it.
    if (text.length > maxBytes || utf8ByteLength(text) > maxBytes) {
        fail(path, `must be at most ${String(maxBytes)} UTF-8 bytes`);
    }

    return text;
};

const readId = (value: unknown, path: string): string => readMatching(value, path, ID_PATTERN, "1-128 characters of [A-Za-z0-9_-]");

/** True when `value` is a valid deployment alias. */
const isAlias = (value: string): boolean => value.length <= HOSTD_PROTOCOL_LIMITS.maxAliasLength && ALIAS_PATTERN.test(value);

/** True when `value` is a protocol id (box, job, deployment, release): 1-128 characters of `[A-Za-z0-9_-]`. */
const isProtocolId = (value: unknown): value is string => typeof value === "string" && ID_PATTERN.test(value);

/** True when `value` is a challenge or request nonce: 22-128 base64url characters. */
const isNonce = (value: unknown): value is string =>
    typeof value === "string" && value.length >= MIN_NONCE_LENGTH && value.length <= MAX_NONCE_LENGTH && BASE64URL_PATTERN.test(value);

/** True when `value` is an upper-snake-case error code of at most 64 characters. */
const isErrorCode = (value: unknown): value is string => typeof value === "string" && ERROR_CODE_PATTERN.test(value);

/** True when `value` has the shape of an Ed25519 signature: 86 base64url characters. Shape only — it is not verified. */
const isSignature = (value: unknown): value is string => typeof value === "string" && value.length === SIGNATURE_LENGTH && BASE64URL_PATTERN.test(value);

/** True when `value` is a version string as `hello` reports one: 1-64 characters of `[A-Za-z0-9_.+~-]`. */
const isVersion = (value: unknown): value is string => typeof value === "string" && VERSION_PATTERN.test(value);

const readAlias = (value: unknown, path: string): string => {
    const alias = readString(value, path);

    if (!isAlias(alias)) {
        fail(path, `must be an alias: dash-separated runs of [a-z0-9], at most ${String(HOSTD_PROTOCOL_LIMITS.maxAliasLength)} characters`);
    }

    return alias;
};

/**
 * True when `value` is a lowercase DNS hostname: 1-63 character labels of
 * `[a-z0-9-]` (no leading or trailing hyphen), at most 253 characters, no
 * trailing dot, and a final label that is not all digits (so never an IPv4
 * address). Internationalised names travel in their `xn--` form.
 */
const isHostname = (value: string): boolean => {
    if (value.length === 0 || value.length > MAX_HOSTNAME_LENGTH) {
        return false;
    }

    const labels = value.split(".");

    if (!labels.every((label) => HOSTNAME_LABEL_PATTERN.test(label))) {
        return false;
    }

    return !ALL_DIGITS_PATTERN.test(labels.at(-1) ?? "");
};

const readHostname = (value: unknown, path: string): string => {
    const hostname = readString(value, path);

    if (!isHostname(hostname)) {
        fail(path, "must be a lowercase DNS hostname");
    }

    return hostname;
};

const readUrl = (value: unknown, path: string): string => {
    const text = readString(value, path);

    if (text.length > HOSTD_PROTOCOL_LIMITS.maxUrlLength || !URL.canParse(text)) {
        return fail(path, `must be an absolute URL of at most ${String(HOSTD_PROTOCOL_LIMITS.maxUrlLength)} characters`);
    }

    const url = new URL(text);

    if (url.protocol !== "https:" && url.protocol !== "http:") {
        fail(path, "must be an http(s) URL");
    }

    if (url.username !== "" || url.password !== "") {
        fail(path, "must not carry credentials");
    }

    return text;
};

/** Validates a challenge nonce. Exported for the signing helpers. */
const readNonce = (value: unknown, path: string): string => {
    const nonce = readMatching(value, path, BASE64URL_PATTERN, "base64url without padding");

    if (nonce.length < MIN_NONCE_LENGTH || nonce.length > MAX_NONCE_LENGTH) {
        fail(path, `must be ${String(MIN_NONCE_LENGTH)}-${String(MAX_NONCE_LENGTH)} base64url characters`);
    }

    return nonce;
};

/** Validates a box id. Exported for the signing helpers. */
const readBoxId = (value: unknown, path: string): string => readId(value, path);

const readErrorDetail = (value: unknown, path: string): ProtocolErrorDetail => {
    const record = readObject(value, path, ["code", "message"]);

    return {
        code: readMatching(record.code, `${path}.code`, ERROR_CODE_PATTERN, "an UPPER_SNAKE_CASE code of at most 64 characters"),
        message: readText(record.message, `${path}.message`, HOSTD_PROTOCOL_LIMITS.maxErrorMessageBytes),
    };
};

/** Rejects a list whose entries repeat a key. */
const assertUnique = (keys: ReadonlyArray<string>, path: string, field: string): void => {
    const seen = new Set<string>();

    for (const [index, key] of keys.entries()) {
        if (seen.has(key)) {
            fail(`${path}[${String(index)}].${field}`, `repeats ${JSON.stringify(key)}`);
        }

        seen.add(key);
    }
};

const readFleet = (value: unknown, path: string): FleetSummary => {
    const record = readObject(value, path, ["alias", "state"], ["deploymentId"]);
    const state = readString(record.state, `${path}.state`);

    if (!FLEET_STATES.has(state)) {
        fail(`${path}.state`, `must be one of ${[...FLEET_STATES].join(", ")}`);
    }

    const fleet: FleetSummary = { alias: readAlias(record.alias, `${path}.alias`), state: state as FleetState };

    if (record.deploymentId !== undefined) {
        fleet.deploymentId = readId(record.deploymentId, `${path}.deploymentId`);
    }

    return fleet;
};

const readVersions = (value: unknown, path: string): BoxVersions => {
    const record = readObject(value, path, ["hostd", "celld", "caddy"]);
    const description = "1-64 characters of [A-Za-z0-9_.+~-]";

    return {
        caddy: readMatching(record.caddy, `${path}.caddy`, VERSION_PATTERN, description),
        celld: readMatching(record.celld, `${path}.celld`, VERSION_PATTERN, description),
        hostd: readMatching(record.hostd, `${path}.hostd`, VERSION_PATTERN, description),
    };
};

const readResources = (value: unknown, path: string): BoxResources => {
    const record = readObject(value, path, ["memMb", "diskFreeMb"]);

    return {
        diskFreeMb: readInteger(record.diskFreeMb, `${path}.diskFreeMb`),
        memMb: readInteger(record.memMb, `${path}.memMb`),
    };
};

const readIsolation = (value: unknown, path: string): BoxIsolation => {
    const record = readObject(value, path, ["status"], ["problems"]);
    const status = readString(record.status, `${path}.status`);

    if (!ISOLATION_STATUSES.has(status)) {
        fail(`${path}.status`, `must be one of ${[...ISOLATION_STATUSES].join(", ")}`);
    }

    const isolation: BoxIsolation = { status: status as IsolationStatus };

    if (record.problems !== undefined) {
        isolation.problems = readArray(record.problems, `${path}.problems`, HOSTD_PROTOCOL_LIMITS.maxIsolationProblems).map((problem, index) =>
            readText(problem, `${path}.problems[${String(index)}]`, HOSTD_PROTOCOL_LIMITS.maxIsolationProblemBytes),
        );
    }

    return isolation;
};

const readHello = (value: unknown, path: string): HelloMessage => {
    const record = readObject(value, path, ["type", "protocol", "boxId", "versions", "fleets", "resources"], ["isolation"]);
    const fleets = readArray(record.fleets, `${path}.fleets`, HOSTD_PROTOCOL_LIMITS.maxFleets).map((fleet, index) =>
        readFleet(fleet, `${path}.fleets[${String(index)}]`),
    );

    assertUnique(
        fleets.map((fleet) => fleet.alias),
        `${path}.fleets`,
        "alias",
    );

    return {
        boxId: readId(record.boxId, `${path}.boxId`),
        fleets,
        ...(record.isolation === undefined ? {} : { isolation: readIsolation(record.isolation, `${path}.isolation`) }),
        protocol: readInteger(record.protocol, `${path}.protocol`, 1),
        resources: readResources(record.resources, `${path}.resources`),
        type: "hello",
        versions: readVersions(record.versions, `${path}.versions`),
    };
};

const readAuth = (value: unknown, path: string): AuthMessage => {
    const record = readObject(value, path, ["type", "signature"]);
    const signature = readMatching(record.signature, `${path}.signature`, BASE64URL_PATTERN, "base64url without padding");

    if (signature.length !== SIGNATURE_LENGTH) {
        fail(`${path}.signature`, `must be a ${String(SIGNATURE_LENGTH)}-character base64url Ed25519 signature`);
    }

    return { signature, type: "auth" };
};

const readProgress = (value: unknown, path: string): ProgressMessage => {
    const record = readObject(value, path, ["type", "jobId", "line"]);

    return {
        jobId: readId(record.jobId, `${path}.jobId`),
        line: readText(record.line, `${path}.line`, HOSTD_PROTOCOL_LIMITS.maxLineBytes),
        type: "progress",
    };
};

const readResult = (value: unknown, path: string): ResultMessage => {
    const record = readObject(value, path, ["type", "jobId", "ok"], ["url", "error"]);
    const result: ResultMessage = { jobId: readId(record.jobId, `${path}.jobId`), ok: readBoolean(record.ok, `${path}.ok`), type: "result" };

    if (record.url !== undefined) {
        result.url = readUrl(record.url, `${path}.url`);
    }

    if (record.error !== undefined) {
        if (result.ok) {
            fail(`${path}.error`, "must be absent when ok is true");
        }

        result.error = readErrorDetail(record.error, `${path}.error`);
    } else if (!result.ok) {
        fail(`${path}.error`, "is required when ok is false");
    }

    return result;
};

const readAliasReport = (value: unknown, path: string): AliasReport => {
    const record = readObject(value, path, ["alias", "requests", "errors"], ["p50Ms"]);
    const report: AliasReport = {
        alias: readAlias(record.alias, `${path}.alias`),
        errors: readInteger(record.errors, `${path}.errors`),
        requests: readInteger(record.requests, `${path}.requests`),
    };

    if (report.errors > report.requests) {
        fail(`${path}.errors`, "must not exceed requests");
    }

    if (record.p50Ms !== undefined) {
        report.p50Ms = readNonNegativeNumber(record.p50Ms, `${path}.p50Ms`);
    }

    return report;
};

const readReport = (value: unknown, path: string): ReportMessage => {
    const record = readObject(value, path, ["type", "windowStart", "windowEnd", "perAlias"]);
    const windowStart = readInteger(record.windowStart, `${path}.windowStart`);
    const windowEnd = readInteger(record.windowEnd, `${path}.windowEnd`);

    if (windowEnd < windowStart) {
        fail(`${path}.windowEnd`, "must not be before windowStart");
    }

    const perAlias = readArray(record.perAlias, `${path}.perAlias`, HOSTD_PROTOCOL_LIMITS.maxReportAliases).map((entry, index) =>
        readAliasReport(entry, `${path}.perAlias[${String(index)}]`),
    );

    assertUnique(
        perAlias.map((entry) => entry.alias),
        `${path}.perAlias`,
        "alias",
    );

    return { perAlias, type: "report", windowEnd, windowStart };
};

const readPong = (value: unknown, path: string): PongMessage => {
    readObject(value, path, ["type"]);

    return { type: "pong" };
};

const readChallenge = (value: unknown, path: string): ChallengeMessage => {
    const record = readObject(value, path, ["type", "nonce"]);

    return { nonce: readNonce(record.nonce, `${path}.nonce`), type: "challenge" };
};

/** Copies a free-form string → string map, validating every name and value. */
const readVariables = (value: unknown, path: string): Record<string, string> => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, "must be an object");
    }

    const variables: Record<string, string> = {};

    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
        // `__proto__` matches the name pattern, and an own `__proto__` key copied
        // with `Object.assign` or a spread would replace the target's prototype.
        if (name === "__proto__" || !VAR_NAME_PATTERN.test(name)) {
            fail(`${path}.${name}`, "must be named like an environment variable ([A-Za-z_][A-Za-z0-9_]*, at most 256 characters)");
        }

        variables[name] = readString(entry, `${path}.${name}`);
    }

    return variables;
};

const readDeployJob = (value: unknown, path: string): DeployJob => {
    const record = readObject(value, path, ["kind", "alias", "deploymentId", "releaseUrl", "vars", "crons"], ["compatibilityDate"]);
    const job: DeployJob = {
        alias: readAlias(record.alias, `${path}.alias`),
        crons: readArray(record.crons, `${path}.crons`, HOSTD_PROTOCOL_LIMITS.maxCrons).map((cron, index) => {
            const cronPath = `${path}.crons[${String(index)}]`;
            const expression = readString(cron, cronPath);

            if (expression.trim().length === 0 || expression.length > MAX_CRON_LENGTH) {
                fail(cronPath, `must be a non-blank cron expression of at most ${String(MAX_CRON_LENGTH)} characters`);
            }

            return expression;
        }),
        deploymentId: readId(record.deploymentId, `${path}.deploymentId`),
        kind: "deploy",
        releaseUrl: readUrl(record.releaseUrl, `${path}.releaseUrl`),
        vars: readVariables(record.vars, `${path}.vars`),
    };

    if (record.compatibilityDate !== undefined) {
        job.compatibilityDate = readMatching(record.compatibilityDate, `${path}.compatibilityDate`, COMPATIBILITY_DATE_PATTERN, "a YYYY-MM-DD date");
    }

    return job;
};

const readDestroyJob = (value: unknown, path: string): DestroyJob => {
    const record = readObject(value, path, ["kind", "alias", "deleteData"]);

    return { alias: readAlias(record.alias, `${path}.alias`), deleteData: readBoolean(record.deleteData, `${path}.deleteData`), kind: "destroy" };
};

const readReloadJob = (value: unknown, path: string): ReloadJob => {
    const record = readObject(value, path, ["kind", "alias"]);

    return { alias: readAlias(record.alias, `${path}.alias`), kind: "reload" };
};

const readUpgradeJob = (value: unknown, path: string): UpgradeJob => {
    const record = readObject(value, path, ["kind", "releaseId", "manifestUrl"], ["allowDowngrade"]);

    return {
        ...(record.allowDowngrade === undefined ? {} : { allowDowngrade: readBoolean(record.allowDowngrade, `${path}.allowDowngrade`) }),
        kind: "upgrade",
        manifestUrl: readUrl(record.manifestUrl, `${path}.manifestUrl`),
        releaseId: readId(record.releaseId, `${path}.releaseId`),
    };
};

const readDiagnoseJob = (value: unknown, path: string): DiagnoseJob => {
    readObject(value, path, ["kind"]);

    return { kind: "diagnose" };
};

const JOB_READERS = new Map<string, (value: unknown, path: string) => HostdJob>([
    ["deploy", readDeployJob],
    ["destroy", readDestroyJob],
    ["diagnose", readDiagnoseJob],
    ["reload", readReloadJob],
    ["upgrade", readUpgradeJob],
]);

const readJob = (value: unknown, path: string): HostdJob => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
        return fail(path, "must be an object");
    }

    const { kind } = value as Record<string, unknown>;
    const reader = typeof kind === "string" ? JOB_READERS.get(kind) : undefined;

    if (reader === undefined) {
        return fail(`${path}.kind`, `must be one of ${[...JOB_READERS.keys()].join(", ")}`);
    }

    return reader(value, path);
};

const readJobMessage = (value: unknown, path: string): JobMessage => {
    const record = readObject(value, path, ["type", "jobId", "job"]);

    return { job: readJob(record.job, `${path}.job`), jobId: readId(record.jobId, `${path}.jobId`), type: "job" };
};

const readRoute = (value: unknown, path: string): RouteEntry => {
    const record = readObject(value, path, ["hostname", "alias"]);

    return { alias: readAlias(record.alias, `${path}.alias`), hostname: readHostname(record.hostname, `${path}.hostname`) };
};

const readRoutes = (value: unknown, path: string): RoutesMessage => {
    const record = readObject(value, path, ["type", "table"]);
    const table = readArray(record.table, `${path}.table`, HOSTD_PROTOCOL_LIMITS.maxRoutes).map((entry, index) =>
        readRoute(entry, `${path}.table[${String(index)}]`),
    );

    assertUnique(
        table.map((entry) => entry.hostname),
        `${path}.table`,
        "hostname",
    );

    return { table, type: "routes" };
};

const readPing = (value: unknown, path: string): PingMessage => {
    readObject(value, path, ["type"]);

    return { type: "ping" };
};

const readCloudError = (value: unknown, path: string): CloudErrorMessage => {
    const record = readObject(value, path, ["type", "code", "message"]);
    const detail = readErrorDetail({ code: record.code, message: record.message }, path);

    return { ...detail, type: "error" };
};

/** Reader for each frame type a box sends. */
const BOX_MESSAGE_READERS: ReadonlyMap<string, (value: unknown, path: string) => BoxMessage> = new Map<
    BoxMessage["type"],
    (value: unknown, path: string) => BoxMessage
>([
    ["auth", readAuth],
    ["hello", readHello],
    ["pong", readPong],
    ["progress", readProgress],
    ["report", readReport],
    ["result", readResult],
]);

/** Reader for each frame type the control plane sends. */
const CLOUD_MESSAGE_READERS: ReadonlyMap<string, (value: unknown, path: string) => CloudMessage> = new Map<
    CloudMessage["type"],
    (value: unknown, path: string) => CloudMessage
>([
    ["challenge", readChallenge],
    ["error", readCloudError],
    ["job", readJobMessage],
    ["ping", readPing],
    ["routes", readRoutes],
]);

export {
    BOX_MESSAGE_READERS,
    CLOUD_MESSAGE_READERS,
    fail,
    InvalidField,
    isAlias,
    isErrorCode,
    isHostname,
    isNonce,
    isProtocolId,
    isSignature,
    isVersion,
    readArray,
    readBoxId,
    readId,
    readInteger,
    readMatching,
    readNonce,
    readObject,
    readString,
    utf8ByteLength,
    VERSION_PATTERN,
};

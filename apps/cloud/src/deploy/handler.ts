import { isLunoraError } from "@lunora/errors";
import { isAlias } from "@lunora/hostd/protocol";

import type { AssetFile, AssetsUpload, BindingRequirement, DeployKind, DeployManifest, TenantDeploymentSpec } from "../provision-contract";
import { tenantResourceName } from "../provision-contract";
import type { TargetDriver } from "../targets/driver";
import { randomSecret } from "./keys";
import type { DeployProgress } from "./orchestrator";
import { runDeployment } from "./orchestrator";
import type { ReleaseBackend, ReleaseDeps } from "./release";
import { buildDeploymentSpec, decodeBundle, reprovision, resolveTelemetrySafely } from "./release";

/**
 * The deploy API request handler. `POST /v1/deploy`:
 * authenticate the bearer deploy key, record a queued deployment, then drive the
 * orchestrator while streaming NDJSON progress (one JSON object per line). The
 * converge runs through the cell scheduler + the project's target driver — both
 * injected, so the whole flow is unit-testable with fakes.
 *
 * Every deploy updates the project's one stable tenant in place (named by the
 * alias), so Durable Object data survives releases. The validated
 * payload is stored first ({@link ReleaseDeps.releases}) — that stored copy is
 * what a rollback, or the automatic revert below, re-provisions.
 *
 * Pure: all I/O is behind {@link DeployBackend} + the injected driver/
 * scheduler/store. The Worker mount in `src/server.ts` wires the backend to the
 * control-plane mutations via the Lunora action context.
 */

export interface DeployTarget {
    organizationId: string;
    projectId?: string;
    type: DeployKind;
}

/**
 * The control-plane operations the deploy flow needs. Every call carries the
 * presented deploy key so the underlying mutations can authorize by key (the
 * deploy request has no user session).
 */
export interface DeployBackend extends ReleaseBackend {
    // Record this now-healthy deployment as live and supersede the previous live
    // release of its alias (GAPS.md A1). Omit to skip pointer management.
    activateDeployment?: (input: { deploymentId: string; key: string }) => Promise<void>;
    /** Record a queued deployment; `previousDeploymentId` is the release of the same alias live before it, if any. */
    createDeployment: (input: {
        adminToken: string;
        branch?: string;
        /** The tenant's compiled cron expressions for the WfP cron fan-out (§2.4). */
        cronSpecs?: string[];
        key: string;
        kind: DeployKind;
        organizationId: string;
        projectId: string; // secret-scanner:allow -- domain field name
        scriptName: string;
    }) => Promise<{ deploymentId: string; previousDeploymentId?: string; version?: number }>;
    updateStatus: (input: {
        bundleHash?: string;
        deploymentId: string;
        key: string;
        status: "failed" | "live" | "provisioning" | "verifying";
        url?: string;
    }) => Promise<void>;
    verifyKey: (key: string) => Promise<DeployTarget | null>;
}

export interface DeployHandlerDeps extends ReleaseDeps {
    /**
     * Record the deployment's outcome for platform self-observability
     * (GAPS.md E1 — the studio observes tenants; nothing observed us).
     *
     * A port rather than a direct call so this module stays free of `env` and
     * `fetch`, and so a test can assert what was recorded without a network
     * double. Fire-and-forget by contract: the implementation must not throw
     * and must not be awaited on the deploy path.
     */
    analytics?: (event: string, properties: Record<string, boolean | number | string>) => void;
    backend: DeployBackend;

    /**
     * Probe the project's URL once the release is on its Worker (GAPS.md A1).
     * `false` fails the deployment and re-provisions the previous live release.
     * Omit to skip health gating.
     */
    healthCheck?: (url: string) => Promise<boolean>;
}

const json = (status: number, data: unknown): Response => Response.json(data, { headers: { "content-type": "application/json" }, status });

interface DeployBody {
    /** Static files behind the manifest's `assets` binding. Validated by {@link parseAssets}. */
    assets?: unknown;
    branch?: string;
    /** Base64-encoded prebuilt worker module (the app's Vite build output — never built here). */
    bundle?: string;
    /** The tenant's cron expressions (wrangler `triggers.crons`) for the fan-out (§2.4). */
    cronSpecs?: string[];

    /**
     * `string`, not `DeployKind` — this is a parsed JSON body, so the declared
     * type is a claim about the wire, not a guarantee. Typing it as the union
     * would narrow the runtime guard below to `never` and quietly delete the only
     * thing standing between an arbitrary value and the deployment row.
     */
    kind?: string;
    /** The Worker's binding manifest. `unknown` because it is untrusted wire data; {@link parseManifest} validates it. */
    manifest?: unknown;
    projectId?: string;
    scriptName?: string;
}

/**
 * Every Lunora tenant worker exports `ShardDO` (binding `SHARD`); without its
 * binding and the matching `new_sqlite_classes` migration tag the uploaded
 * dispatch script cannot boot. The floor is added whenever the manifest does
 * not already bind the class, so an under-declaring caller still comes up.
 */
const SHARD_DO_BINDING: BindingRequirement = { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" };

/**
 * The whole request — bundle and assets travel base64 in one JSON body — is
 * capped before it is parsed. 50 MiB of assets is ~67 MiB base64, which leaves
 * room for the bundle; it is also Cloudflare's own request-size floor.
 */
const MAX_BODY_BYTES = 100 * 1024 * 1024;
/** Caps so a malformed/abusive manifest can't balloon the upload metadata. */
const MAX_BINDINGS = 64;
const MAX_DURABLE_OBJECTS = 25;
const MAX_COMPATIBILITY_FLAGS = 32;
const MAX_ASSET_FILES = 20_000;
const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
const MAX_ASSETS_BYTES = 50 * 1024 * 1024;
const MAX_RUN_WORKER_FIRST_RULES = 100;

/** Binding names become `env` keys and resource-name suffixes, so they stay identifier-shaped. */
const IDENTIFIER = /^[A-Za-z_]\w{0,63}$/u;
const COMPATIBILITY_DATE = /^\d{4}-\d{2}-\d{2}$/u;
const COMPATIBILITY_FLAG = /^[a-z0-9_]{1,64}$/u;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;
/** Bucket / queue / dataset names across the types that carry one. */
const RESOURCE_NAME = /^[\w.-]{1,63}$/u;

const HTML_HANDLING = ["auto-trailing-slash", "drop-trailing-slash", "force-trailing-slash", "none"] as const;
const NOT_FOUND_HANDLING = ["404-page", "none", "single-page-application"] as const;
const ASSETS_CONFIG_KEYS = new Set(["html_handling", "not_found_handling", "run_worker_first"]);

type BindingType = BindingRequirement["type"];

/** What validating a manifest needs from the project's target. */
type TargetSupport = Pick<TargetDriver, "bindingSupport" | "id" | "unsupportedReasons">;

/** Validation outcome: the parsed value, or the 400 message. */
type Parsed<T> = { error: string } | { value: T };

const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every table names every type `@lunora/config` emits, so any target's table answers "is this a binding type". */
const isBindingType = (value: string, target: TargetSupport): value is BindingType => Object.hasOwn(target.bindingSupport, value);

/** Class-backed types the platform binds straight to an export of the tenant bundle. */
const needsClassName = (type: BindingType): boolean => type === "durable_object" || type === "workflow";

const parseBinding = (entry: unknown, index: number, target: TargetSupport): Parsed<BindingRequirement> => {
    if (!isRecord(entry) || typeof entry["binding"] !== "string" || typeof entry["type"] !== "string") {
        return { error: `manifest.bindings[${String(index)}] must be an object with string \`binding\` and \`type\`` };
    }

    const { binding, className, resource, sqlite, type } = entry;

    if (!IDENTIFIER.test(binding)) {
        return { error: `binding name "${binding}" must match ${IDENTIFIER.source} (it becomes an env key)` };
    }

    if (!isBindingType(type, target)) {
        return { error: `binding ${binding} has unknown type "${type}"` };
    }

    if (className !== undefined && (typeof className !== "string" || !IDENTIFIER.test(className))) {
        return { error: `binding ${binding}: className must be an identifier` };
    }

    if (needsClassName(type) && className === undefined) {
        return { error: `binding ${binding}: a ${type} binding needs a className` };
    }

    if (resource !== undefined && (typeof resource !== "string" || !RESOURCE_NAME.test(resource))) {
        return { error: `binding ${binding}: resource must match ${RESOURCE_NAME.source}` };
    }

    if (sqlite !== undefined && typeof sqlite !== "boolean") {
        return { error: `binding ${binding}: sqlite must be a boolean` };
    }

    // Rebuilt field by field so unknown keys never reach a driver.
    // `resourceId` is deliberately not carried: an id minted in the tenant's own
    // account means nothing in the platform account, and honouring one would let
    // a manifest point a binding at another tenant's resource.
    return {
        value: {
            binding,
            type,
            ...(typeof className === "string" ? { className } : {}),
            ...(typeof resource === "string" ? { resource } : {}),
            ...(typeof sqlite === "boolean" ? { sqlite } : {}),
        },
    };
};

/** Checks across the (floored) binding list: unique names and per-type caps. */
const bindingSetError = (bindings: BindingRequirement[]): string | undefined => {
    const names = new Set<string>();

    for (const { binding } of bindings) {
        // Case-insensitive: per-project resource names fold case, so `DB` and
        // `db` would share one database.
        if (names.has(binding.toLowerCase())) {
            return `binding name ${binding} is declared more than once (names are compared case-insensitively)`;
        }

        names.add(binding.toLowerCase());
    }

    if (bindings.filter((entry) => entry.type === "durable_object").length > MAX_DURABLE_OBJECTS) {
        return `manifest declares more than ${String(MAX_DURABLE_OBJECTS)} durable_object bindings`;
    }

    if (bindings.filter((entry) => entry.type === "assets").length > 1) {
        return "manifest declares more than one assets binding";
    }

    // Alchemy (and so the provision box) always binds uploaded assets as `ASSETS`.
    const assets = bindings.find((entry) => entry.type === "assets");

    if (assets && assets.binding !== "ASSETS") {
        return `the assets binding must be named ASSETS on Lunora Cloud, not ${assets.binding}`;
    }

    return undefined;
};

const parseCompatibility = (date: unknown, flags: unknown): Parsed<Pick<DeployManifest, "compatibilityDate" | "compatibilityFlags">> => {
    if (date !== undefined && (typeof date !== "string" || !COMPATIBILITY_DATE.test(date))) {
        return { error: "manifest.compatibilityDate must be YYYY-MM-DD" };
    }

    if (flags === undefined) {
        return { value: typeof date === "string" ? { compatibilityDate: date } : {} };
    }

    if (!Array.isArray(flags) || flags.length > MAX_COMPATIBILITY_FLAGS || !flags.every((flag) => typeof flag === "string" && COMPATIBILITY_FLAG.test(flag))) {
        return { error: `manifest.compatibilityFlags must be at most ${String(MAX_COMPATIBILITY_FLAGS)} strings matching ${COMPATIBILITY_FLAG.source}` };
    }

    return {
        value: {
            ...(typeof date === "string" ? { compatibilityDate: date } : {}),
            compatibilityFlags: flags.filter((flag): flag is string => typeof flag === "string"),
        },
    };
};

/**
 * Validate the request's binding manifest against the project's target and
 * floor it to ShardDO.
 *
 * Every refusal happens here, before a deployment row is recorded or anything
 * is provisioned. A binding the target marks `unsupported` is refused rather
 * than dropped: a missing binding otherwise surfaces as an undefined `env.X`
 * long after a green deploy. All unsupported entries are reported at once, with
 * the target's own reason, so one retry fixes them.
 */
const parseManifest = (raw: unknown, target: TargetSupport): Parsed<DeployManifest> => {
    const input = raw ?? { bindings: [] };

    if (!isRecord(input) || !Array.isArray(input["bindings"])) {
        return { error: "manifest must be an object with a `bindings` array" };
    }

    const { bindings: entries, compatibilityDate, compatibilityFlags } = input;

    if (entries.length > MAX_BINDINGS) {
        return { error: `manifest declares ${String(entries.length)} bindings; the limit is ${String(MAX_BINDINGS)}` };
    }

    const bindings: BindingRequirement[] = [];
    const unsupported: string[] = [];

    for (const [index, entry] of entries.entries()) {
        const parsed = parseBinding(entry, index, target);

        if ("error" in parsed) {
            return parsed;
        }

        const { binding, type } = parsed.value;

        if (target.bindingSupport[type] === "unsupported") {
            unsupported.push(`${type} (${binding}): ${target.unsupportedReasons[type] ?? `not supported on ${target.id}`}`);
        }

        bindings.push(parsed.value);
    }

    if (unsupported.length > 0) {
        return { error: `Lunora Cloud cannot provide these bindings on the ${target.id} target — ${unsupported.join("; ")}` };
    }

    if (!bindings.some((entry) => entry.type === "durable_object" && entry.className === SHARD_DO_BINDING.className)) {
        bindings.unshift({ ...SHARD_DO_BINDING });
    }

    const setError = bindingSetError(bindings);

    if (setError !== undefined) {
        return { error: setError };
    }

    const compatibility = parseCompatibility(compatibilityDate, compatibilityFlags);

    return "error" in compatibility ? compatibility : { value: { bindings, ...compatibility.value } };
};

/** Decoded byte length of a base64 string, without decoding it. */
const base64Bytes = (encoded: string): number => (encoded.length / 4) * 3 - (Number(encoded.endsWith("=")) + Number(encoded.endsWith("==")));

const parseAssetsConfig = (raw: unknown): Parsed<AssetsUpload["config"]> => {
    if (raw === undefined) {
        return { value: undefined };
    }

    if (!isRecord(raw)) {
        return { error: "assets.config must be an object" };
    }

    const unknownKey = Object.keys(raw).find((key) => !ASSETS_CONFIG_KEYS.has(key));

    if (unknownKey !== undefined) {
        return { error: `assets.config.${unknownKey} is not supported; allowed: ${[...ASSETS_CONFIG_KEYS].join(", ")}` };
    }

    const { html_handling: htmlHandling, not_found_handling: notFoundHandling, run_worker_first: runWorkerFirst } = raw;
    const config: NonNullable<AssetsUpload["config"]> = {};

    if (htmlHandling !== undefined) {
        if (!isOneOf(HTML_HANDLING, htmlHandling)) {
            return { error: `assets.config.html_handling must be one of ${HTML_HANDLING.join(", ")}` };
        }

        config.html_handling = htmlHandling;
    }

    if (notFoundHandling !== undefined) {
        if (!isOneOf(NOT_FOUND_HANDLING, notFoundHandling)) {
            return { error: `assets.config.not_found_handling must be one of ${NOT_FOUND_HANDLING.join(", ")}` };
        }

        config.not_found_handling = notFoundHandling;
    }

    if (runWorkerFirst !== undefined) {
        const valid =
            typeof runWorkerFirst === "boolean" ||
            (Array.isArray(runWorkerFirst) &&
                runWorkerFirst.length <= MAX_RUN_WORKER_FIRST_RULES &&
                runWorkerFirst.every((rule) => typeof rule === "string" && rule.length > 0 && rule.length <= 256));

        if (!valid) {
            return { error: `assets.config.run_worker_first must be a boolean or at most ${String(MAX_RUN_WORKER_FIRST_RULES)} route patterns` };
        }

        config.run_worker_first =
            typeof runWorkerFirst === "boolean" ? runWorkerFirst : runWorkerFirst.filter((rule): rule is string => typeof rule === "string");
    }

    return { value: config };
};

/** One asset file: a rooted path with no traversal, and base64 content under the per-file cap. */
const parseAssetFile = (entry: unknown, index: number): Parsed<AssetFile> => {
    if (!isRecord(entry) || typeof entry["path"] !== "string" || typeof entry["content"] !== "string") {
        return { error: `assets.files[${String(index)}] must be an object with string \`path\` and \`content\`` };
    }

    const { content, path } = entry;

    if (!path.startsWith("/") || path.includes("\0") || path.split("/").includes("..")) {
        return { error: `asset path ${JSON.stringify(path)} must start with / and contain no .. segment or NUL` };
    }

    if (content.length % 4 !== 0 || !BASE64.test(content)) {
        return { error: `asset ${path} is not valid base64` };
    }

    const size = base64Bytes(content);

    if (size > MAX_ASSET_FILE_BYTES) {
        return { error: `asset ${path} is ${String(size)} bytes; the per-file limit is ${String(MAX_ASSET_FILE_BYTES)}` };
    }

    return { value: { content, path } };
};

/**
 * Validate the static-asset upload against the (already validated) manifest:
 * an `assets` binding needs files, and files need an `assets` binding.
 */
const parseAssets = (raw: unknown, manifest: DeployManifest): Parsed<AssetsUpload | undefined> => {
    const bound = manifest.bindings.some((entry) => entry.type === "assets");

    if (raw === undefined) {
        return bound ? { error: "the manifest has an assets binding but the request carries no assets" } : { value: undefined };
    }

    if (!bound) {
        return { error: "assets were sent but the manifest has no assets binding" };
    }

    if (!isRecord(raw) || !Array.isArray(raw["files"]) || raw["files"].length === 0) {
        return { error: "assets.files must be a non-empty array" };
    }

    const { files: entries } = raw;

    if (entries.length > MAX_ASSET_FILES) {
        return { error: `assets carry ${String(entries.length)} files; the limit is ${String(MAX_ASSET_FILES)}` };
    }

    const files: AssetFile[] = [];
    const paths = new Set<string>();
    let total = 0;

    for (const [index, entry] of entries.entries()) {
        const parsed = parseAssetFile(entry, index);

        if ("error" in parsed) {
            return parsed;
        }

        const { content, path } = parsed.value;

        if (paths.has(path)) {
            return { error: `asset path ${path} appears more than once` };
        }

        total += base64Bytes(content);

        if (total > MAX_ASSETS_BYTES) {
            return { error: `assets exceed the ${String(MAX_ASSETS_BYTES)}-byte total limit` };
        }

        paths.add(path);
        files.push({ content, path });
    }

    const config = parseAssetsConfig(raw["config"]);

    if ("error" in config) {
        return config;
    }

    return { value: { files, ...(config.value ? { config: config.value } : {}) } };
};

/** Every per-project resource name must fit Cloudflare's limits — refused here, not halfway through provisioning. */
const resourceNameError = (alias: string, manifest: DeployManifest, target: TargetSupport): string | undefined => {
    for (const requirement of manifest.bindings) {
        if (target.bindingSupport[requirement.type] !== "provisioned") {
            continue;
        }

        try {
            tenantResourceName(alias, requirement);
        } catch (error) {
            return error instanceof Error ? error.message : String(error);
        }
    }

    return undefined;
};

const parsePayload = (
    body: Pick<ReleaseRequest, "assets" | "manifest">,
    alias: string,
    target: TargetSupport,
): Parsed<{ assets: AssetsUpload | undefined; manifest: DeployManifest }> => {
    // The script name is the project alias: it becomes the public subdomain and
    // keys every per-project resource, so it must be a shape that cannot collide.
    if (!isAlias(alias)) {
        return { error: "scriptName must be lowercase letters and digits in dash-separated runs, at most 63 characters" };
    }

    const manifest = parseManifest(body.manifest, target);

    if ("error" in manifest) {
        return manifest;
    }

    const nameError = resourceNameError(alias, manifest.value, target);

    if (nameError !== undefined) {
        return { error: nameError };
    }

    const assets = parseAssets(body.assets, manifest.value);

    return "error" in assets ? assets : { value: { assets: assets.value, manifest: manifest.value } };
};

/**
 * Read the JSON body, refusing anything over {@link MAX_BODY_BYTES} — checked
 * against `content-length` first so an honest oversized upload is refused
 * unread, then against the bytes actually read, since a chunked body has no
 * declared length.
 */
const readBody = async (request: Request): Promise<{ body: DeployBody } | { response: Response }> => {
    const tooLarge = { response: json(413, { error: `request body exceeds ${String(MAX_BODY_BYTES)} bytes` }) };
    const declared = Number(request.headers.get("content-length") ?? Number.NaN);

    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return tooLarge;
    }

    const bytes = await request.arrayBuffer();

    if (bytes.byteLength > MAX_BODY_BYTES) {
        return tooLarge;
    }

    try {
        const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));

        return isRecord(parsed) ? { body: parsed } : { response: json(400, { error: "request body must be a JSON object" }) };
    } catch {
        return { response: json(400, { error: "invalid JSON body" }) };
    }
};

/**
 * Deploy kinds ordered by privilege, least to most.
 *
 * `production` is the only one that can move a project's stable URL, so it sits
 * at the top; a key scoped to a lower rung may deploy at or below its own.
 */
const DEPLOY_RANK: Record<DeployKind, number> = { dev: 0, preview: 1, production: 2 };

/**
 * Whether a value is one of the three deploy kinds.
 *
 * `body.kind` arrives as an arbitrary string and flowed straight into the
 * deployment row and the dispatch-namespace name. Unvalidated it was worse than
 * untyped: an unknown kind ranked below every key scope, so it sailed through the
 * ceiling check below — and `activate` supersedes only SAME-KIND siblings, so a
 * deployment stamped `"prod"` would never supersede the real `production` release
 * and the real one would never supersede it. Two live releases, neither aware of
 * the other.
 */
const isDeployKind = (value: string): value is DeployKind => value === "dev" || value === "preview" || value === "production";

/** Whether a requested deploy kind is within the key's own scope. */
const deployKindWithin = (requested: DeployKind, allowed: DeployKind): boolean => DEPLOY_RANK[requested] <= DEPLOY_RANK[allowed];

const bearerKey = (request: Request): null | string => {
    const header = request.headers.get("authorization") ?? "";
    const [scheme, ...rest] = header.split(" ");

    if (scheme?.toLowerCase() !== "bearer") {
        return null;
    }

    const key = rest.join(" ").trim();

    return key === "" ? null : key;
};

/**
 * Put the previous live release back after a release failed its health check.
 *
 * The check runs AFTER cutover — the project has one Worker, and Workers for
 * Platforms cannot stage a user Worker's version — so a failed check means the
 * broken release is already serving. There is no previous release on a
 * project's first deploy, and then the failed release stays up: it is all there
 * is. Reports each step as an NDJSON event; never throws.
 */
const revertFailedRelease = async (
    input: { deploymentId: string; key: string; organizationId: string; previousDeploymentId: string | undefined },
    deps: ReleaseDeps,
    write: (frame: ReleaseFrame) => void,
): Promise<void> => {
    const { deploymentId, previousDeploymentId } = input;

    if (previousDeploymentId === undefined) {
        write({ deploymentId, event: "not_reverted", reason: "no previous release to revert to" });

        return;
    }

    write({ deploymentId, event: "reverting", to: previousDeploymentId });

    try {
        await reprovision({ deploymentId: previousDeploymentId, key: input.key, organizationId: input.organizationId }, deps);
        write({ deploymentId, event: "reverted", to: previousDeploymentId });
    } catch (error) {
        write({ deploymentId, error: error instanceof Error ? error.message : String(error), event: "revert_failed", to: previousDeploymentId });
    }
};

/** What a release ships: the deploy request body minus its credential, whichever transport carried it. */
export interface ReleaseRequest {
    /** Static files behind the manifest's `assets` binding. Validated by {@link parseAssets}. */
    assets?: unknown;
    branch?: string;
    /** Base64-encoded prebuilt worker module (built by the app's pipeline or the build box — never here). */
    bundle?: string;
    /** The tenant's cron expressions (wrangler `triggers.crons`) for the fan-out (§2.4). Untrusted. */
    cronSpecs?: unknown;
    /** Already checked against the caller's ceiling — {@link startRelease} does not re-rank it. */
    kind: DeployKind;
    /** The Worker's binding manifest. `unknown` because it is untrusted wire data; {@link parseManifest} validates it. */
    manifest?: unknown;
    projectId: string;
    scriptName: string;
}

/** Who asked: the deploy key every backend call authorizes by, and the organization it resolved to. */
export interface ReleaseCaller {
    key: string;
    organizationId: string;
}

/** How a release ended. `error` is set exactly when `status` is `failed`. */
export interface ReleaseOutcome {
    deploymentId: string;
    error?: string;
    status: "failed" | "live";
    url?: string;
}

/**
 * One progress frame: an NDJSON line on `POST /v1/deploy`, a `buildLogs` line
 * for a git build. A closed union, so every reader of the stream (the CLI's
 * printer, `describeReleaseFrame` for git builds) is told when a frame is added.
 */
export type ReleaseFrame =
    /** An orchestrator phase — the deployment-state transitions, `failed` carrying its error. */
    | (DeployProgress & { deploymentId: string })
    /** The release's last frame. */
    | { deploymentId: string; done: true; status: ReleaseOutcome["status"] }
    | { deploymentId: string; error: string; event: "revert_failed"; to: string }
    | { deploymentId: string; event: "accepted" | "released" }
    | { deploymentId: string; event: "not_reverted"; reason: string }
    | { deploymentId: string; event: "reverted" | "reverting"; to: string }
    /** One progress line from the target while it converges (`celld-vps`: the box's job output). */
    | { deploymentId: string; log: string };

/**
 * A release that passed validation and has a deployment row, ready to run — or
 * the reason it was refused before anything was recorded. Split in two because
 * the HTTP route answers the refusal as a status code and the run as a stream.
 */
export type StartedRelease =
    { deploymentId: string; run: (write: (frame: ReleaseFrame) => void) => Promise<ReleaseOutcome> } | { error: string; status: 400 | 403 | 409 | 501 };

/** What {@link runRelease} needs to know about a release it was handed. */
interface RecordedRelease {
    adminToken: string;
    assets: AssetsUpload | undefined;
    bundle: ArrayBuffer;
    caller: ReleaseCaller;
    cronSpecs: string[] | undefined;
    deploymentId: string;
    /** The project's target driver — resolved before the row was recorded, so a missing one refused the release. */
    driver: TargetDriver;
    encodedBundle: string;
    kind: DeployKind;
    manifest: DeployManifest;
    previousDeploymentId: string | undefined;
    projectId: string;
    scriptName: string;
}

/**
 * The target-neutral spec for a release. Tenant env secrets are decrypted and
 * merged in; `LUNORA_ADMIN_TOKEN` is platform-owned and always wins over a
 * same-named tenant secret. Throws when the secrets cannot be resolved.
 */
const releaseSpec = async (release: RecordedRelease, deps: DeployHandlerDeps): Promise<TenantDeploymentSpec> => {
    const { key, organizationId } = release.caller;
    const { kind, projectId } = release;
    const tenantSecrets = (await deps.backend.resolveSecrets?.({ key, kind, organizationId, projectId })) ?? {};

    return buildDeploymentSpec({
        adminToken: release.adminToken,
        alias: release.scriptName,
        assets: release.assets,
        bundle: release.bundle,
        ...(release.cronSpecs ? { cronSpecs: release.cronSpecs } : {}),
        deploymentId: release.deploymentId,
        kind,
        manifest: release.manifest,
        organizationId,
        projectId,
        telemetry: await resolveTelemetrySafely(deps, { key, organizationId }),
        tenantSecrets,
    });
};

const withUrl = (url: string | undefined): { url?: string } => (url === undefined ? {} : { url });

/**
 * Forward each orchestrator phase as a frame, and record the ones that are
 * deployment states on the row. `onUrl` learns the Worker's URL as soon as a
 * phase carries it, so a release that fails its health check still reports where.
 */
const reportProgress =
    (release: { deploymentId: string; deps: DeployHandlerDeps; key: string; write: (frame: ReleaseFrame) => void }, onUrl: (url: string) => void) =>
    async (progress: DeployProgress): Promise<void> => {
        const { deploymentId, deps, key, write } = release;

        if (progress.url !== undefined) {
            onUrl(progress.url);
        }

        write({ ...progress, deploymentId });

        if (progress.phase === "provisioning" || progress.phase === "verifying" || progress.phase === "live" || progress.phase === "failed") {
            await deps.backend.updateStatus({ bundleHash: progress.bundleHash, deploymentId, key, status: progress.phase, url: progress.url });
        }
    };

/**
 * Drive one recorded release: store it, resolve its secrets, provision it, gate
 * it on a health check (reverting a failed one), and record it live. Reports
 * every step through `write`; never throws — a failure is the outcome.
 */
const runRelease = async (release: RecordedRelease, deps: DeployHandlerDeps, write: (frame: ReleaseFrame) => void): Promise<ReleaseOutcome> => {
    const { assets, caller, deploymentId, kind, manifest } = release;
    const { key, organizationId } = caller;
    let url: string | undefined;

    /**
     * The one terminal-failure path: emit the failed phase + done frames and
     * best-effort mark the row failed. Extracted because three call sites had to
     * do every step in order, and a missed one strands the row mid-flight with
     * the client still hanging.
     */
    const fail = async (error: unknown, fallback: string): Promise<ReleaseOutcome> => {
        const message = error instanceof Error ? error.message : fallback;

        write({ deploymentId, error: message, phase: "failed" });

        try {
            await deps.backend.updateStatus({ deploymentId, key, status: "failed" });
        } catch {
            // The status write is the likeliest thing to have just failed;
            // reporting the failure downstream matters more than recording it.
        }

        write({ deploymentId, done: true, status: "failed" });

        return { deploymentId, error: message, status: "failed", ...withUrl(url) };
    };

    write({ deploymentId, event: "accepted" });

    // Stored BEFORE anything touches the Worker: this copy is what a later
    // rollback — or the revert below — puts back, so a release that is not
    // stored must never go live.
    try {
        await deps.releases.put(deploymentId, { ...(assets ? { assets } : {}), bundle: release.encodedBundle, manifest });
    } catch (error) {
        return fail(new Error(`failed to store the release: ${error instanceof Error ? error.message : String(error)}`), "");
    }

    // A decrypt failure (e.g. a corrupt secret or a rotated master key) must
    // surface as a failed deployment, not leave the row stuck in `accepted`.
    let spec: TenantDeploymentSpec;

    try {
        spec = await releaseSpec(release, deps);
    } catch (error) {
        return fail(error, "failed to resolve tenant secrets");
    }

    const { healthCheck } = deps;

    let outcome: Awaited<ReturnType<typeof runDeployment>>;

    try {
        outcome = await runDeployment(spec, {
            onProgress: reportProgress({ deploymentId, deps, key, write }, (progressUrl) => {
                url = progressUrl;
            }),
            driver: release.driver,
            scheduler: deps.scheduler,
            ...(healthCheck ? { verify: (result) => healthCheck(result.url) } : {}),
        });
    } catch (error) {
        // `runDeployment` converts driver/scheduler faults into
        // `{ status: "failed" }` itself, so reaching here means the *callback*
        // threw — an `updateStatus` write that failed, most likely. Without
        // this the row is stranded mid-flight in `accepted`/`provisioning`
        // forever, and an HTTP client hangs instead of seeing a failure.
        return fail(error, "deployment failed");
    }

    if (outcome.status === "failed" && outcome.provisioned) {
        await revertFailedRelease({ deploymentId, key, organizationId, previousDeploymentId: release.previousDeploymentId }, deps, write);
    }

    // Health-checked release: record it live and supersede the previous
    // one (GAPS.md A1). An activation failure downgrades the release to
    // failed, but the Worker already runs it — the record is what lags.
    if (outcome.status === "live" && deps.backend.activateDeployment) {
        try {
            await deps.backend.activateDeployment({ deploymentId, key });
            write({ deploymentId, event: "released" });
        } catch (error) {
            return fail(error, "activation failed");
        }
    }

    // Outcome, not progress: one event per deploy, carrying ids and a
    // status. Never the script, its bindings, or the tenant's URL.
    deps.analytics?.("cloud_deployment_finished", { deploymentId, kind, status: outcome.status });

    write({ deploymentId, done: true, status: outcome.status });

    return outcome.status === "live"
        ? { deploymentId, status: "live", url: outcome.result.url }
        : { deploymentId, error: outcome.error, status: "failed", ...withUrl(url) };
};

/**
 * The project's target driver, or why the release is refused: a project placed
 * on another cell (409), a target with no driver yet (501), a project the caller
 * cannot see (403).
 */
const projectDriver = async (
    projectId: string, // secret-scanner:allow -- domain field name
    caller: ReleaseCaller,
    deps: DeployHandlerDeps,
    onProgress: (line: string) => void,
): Promise<{ driver: TargetDriver } | { error: string; status: 403 | 409 | 501 }> => {
    try {
        const placement = await deps.backend.placement({ key: caller.key, organizationId: caller.organizationId, projectId });

        return { driver: deps.driverFor(placement, { onProgress }) };
    } catch (error) {
        const message = error instanceof Error ? error.message : "this project cannot be placed";
        const status = isLunoraError(error) ? error.status : 403;

        return { error: message, status: status === 409 || status === 501 ? status : 403 };
    }
};

/**
 * The deploy core, transport-agnostic: validate a release, record its
 * deployment, and hand back the run. `POST /v1/deploy` calls it with the
 * presented deploy key and streams the run as NDJSON; a git build
 * (`src/builds/release.ts`) calls it with a key the platform minted for that one
 * release and writes the run into the build's log. Same validation, same
 * stored release, same health gate and revert — one pipeline, two callers.
 *
 * Every refusal happens before a deployment row exists or anything is provisioned.
 */
export const startRelease = async (request: ReleaseRequest, caller: ReleaseCaller, deps: DeployHandlerDeps): Promise<StartedRelease> => {
    // The worker bundle is prebuilt (the app's Vite pipeline, or the build box);
    // deploying without one would provision an empty module, so fail fast.
    if (!request.bundle) {
        return { error: "bundle is required (base64-encoded worker module)", status: 400 };
    }

    const encodedBundle = request.bundle;
    const bundle = decodeBundle(encodedBundle);

    if (!bundle) {
        return { error: "bundle is not valid base64", status: 400 };
    }

    // Placement and driver first: the project's target decides which binding
    // table the payload is validated against, a project placed on another cell
    // is refused here, and a target with no driver must refuse before anything
    // is recorded.
    // The driver's progress lines join the release's own stream once it runs
    // (`{ deploymentId, log }` frames); a target that reports none adds none.
    let progressSink: ((line: string) => void) | undefined;
    const placed = await projectDriver(request.projectId, caller, deps, (line) => {
        progressSink?.(line);
    });

    if ("error" in placed) {
        return placed;
    }

    const { driver } = placed;
    const payload = parsePayload(request, request.scriptName, driver);

    if ("error" in payload) {
        return { error: payload.error, status: 400 };
    }

    const { assets, manifest } = payload.value;
    const { branch, kind, projectId, scriptName } = request;
    // Tenant cron expressions to fan out (§2.4). Defensive: only strings, capped.
    const cronSpecs = Array.isArray(request.cronSpecs) ? request.cronSpecs.filter((cron): cron is string => typeof cron === "string").slice(0, 50) : undefined;

    // The platform-minted tenant admin token: recorded on the deployment (for the
    // admin proxy) and set as the worker's LUNORA_ADMIN_TOKEN secret.
    const adminToken = randomSecret();

    let created: { deploymentId: string; previousDeploymentId?: string };

    try {
        created = await deps.backend.createDeployment({
            adminToken,
            branch,
            ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
            key: caller.key,
            kind,
            organizationId: caller.organizationId,
            projectId,
            scriptName,
        });
    } catch (error) {
        return { error: error instanceof Error ? error.message : "failed to record deployment", status: 403 };
    }

    const { deploymentId, previousDeploymentId } = created;

    return {
        deploymentId,
        run: (write) => {
            progressSink = (line) => {
                write({ deploymentId, log: line });
            };

            return runRelease(
                {
                    adminToken,
                    assets,
                    bundle,
                    caller,
                    cronSpecs,
                    deploymentId,
                    driver,
                    encodedBundle,
                    kind,
                    manifest,
                    previousDeploymentId,
                    projectId,
                    scriptName,
                },
                deps,
                write,
            );
        },
    };
};

export const handleDeployRequest = async (request: Request, deps: DeployHandlerDeps): Promise<Response> => {
    const key = bearerKey(request);

    if (!key) {
        return json(401, { error: "missing bearer deploy key" });
    }

    const target = await deps.backend.verifyKey(key);

    if (!target) {
        return json(403, { error: "invalid or revoked deploy key" });
    }

    const read = await readBody(request);

    if ("response" in read) {
        return read.response;
    }

    const { body } = read;

    if (!body.projectId || !body.scriptName) {
        return json(400, { error: "projectId and scriptName are required" });
    }

    // Checked here rather than in the core so a malformed upload keeps the
    // error it always got first.
    if (!body.bundle) {
        return json(400, { error: "bundle is required (base64-encoded worker module)" });
    }

    const kind = body.kind ?? target.type;

    if (!isDeployKind(kind)) {
        return json(400, { error: `unknown deploy kind "${kind}" — expected dev, preview or production` });
    }

    // The key's `type` is a CEILING, not just a default.
    //
    // It was only ever used to default `kind`, so `body.kind` overrode it freely
    // and a key issued — and shown in the UI — as `dev` or `preview` could deploy
    // `production`: activating the project's stable-URL pointer and superseding the
    // live release. Operators hand out "preview-only" keys on the reasonable
    // assumption that the scope binds somewhere, and it did not.
    if (!deployKindWithin(kind, target.type)) {
        return json(403, {
            error: `this deploy key is scoped to ${target.type} and cannot deploy ${kind}. Issue a ${kind} key, or deploy with kind "${target.type}".`,
        });
    }

    const started = await startRelease(
        {
            assets: body.assets,
            branch: body.branch,
            bundle: body.bundle,
            cronSpecs: body.cronSpecs,
            kind,
            manifest: body.manifest,
            projectId: body.projectId,
            scriptName: body.scriptName,
        },
        { key, organizationId: target.organizationId },
        deps,
    );

    if ("error" in started) {
        return json(started.status, { error: started.error });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            await started.run((frame) => {
                controller.enqueue(encoder.encode(`${JSON.stringify(frame)}\n`));
            });
            controller.close();
        },
    });

    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-accel-buffering": "no" }, status: 200 });
};

import type { AssetFile, AssetsUpload, BindingRequirement, DeployManifest } from "../provision-contract";
import { ALIAS_PATTERN, BINDING_SUPPORT, tenantResourceName, UNSUPPORTED_REASONS } from "../provision-contract";
import { randomSecret } from "./keys";
import type { DeployProgress } from "./orchestrator";
import { runDeployment } from "./orchestrator";
import type { DeployKind, ReleaseBackend, ReleaseDeps } from "./release";
import { buildDeploymentSpec, decodeBundle, reprovision, resolveTelemetrySafely } from "./release";

/**
 * The deploy API request handler. `POST /v1/deploy`:
 * authenticate the bearer deploy key, record a queued deployment, then drive the
 * orchestrator while streaming NDJSON progress (one JSON object per line). The
 * Cloudflare-touching work runs through the cell scheduler + the Alchemy
 * provisioner — both injected, so the whole flow is unit-testable with fakes.
 *
 * Every deploy updates the project's one stable Worker in place (the script
 * name is the alias), so Durable Object data survives releases. The validated
 * payload is stored first ({@link ReleaseDeps.releases}) — that stored copy is
 * what a rollback, or the automatic revert below, re-provisions.
 *
 * Pure: all I/O is behind {@link DeployBackend} + the injected provisioner/
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
type UnsupportedType = keyof typeof UNSUPPORTED_REASONS;

/** Validation outcome: the parsed value, or the 400 message. */
type Parsed<T> = { error: string } | { value: T };

const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const isBindingType = (value: string): value is BindingType => Object.hasOwn(BINDING_SUPPORT, value);

const isUnsupported = (type: BindingType): type is UnsupportedType => BINDING_SUPPORT[type] === "unsupported";

/** Class-backed types the platform binds straight to an export of the tenant bundle. */
const needsClassName = (type: BindingType): boolean => type === "durable_object" || type === "workflow";

const parseBinding = (entry: unknown, index: number): Parsed<BindingRequirement> => {
    if (!isRecord(entry) || typeof entry["binding"] !== "string" || typeof entry["type"] !== "string") {
        return { error: `manifest.bindings[${String(index)}] must be an object with string \`binding\` and \`type\`` };
    }

    const { binding, className, resource, sqlite, type } = entry;

    if (!IDENTIFIER.test(binding)) {
        return { error: `binding name "${binding}" must match ${IDENTIFIER.source} (it becomes an env key)` };
    }

    if (!isBindingType(type)) {
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

    // Rebuilt field by field so unknown keys never reach the provisioner.
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
 * Validate the request's binding manifest and floor it to ShardDO.
 *
 * Every refusal happens here, before a deployment row is recorded or anything
 * is provisioned. An `unsupported` binding is refused rather than dropped: a
 * missing binding otherwise surfaces as an undefined `env.X` long after a green
 * deploy. All unsupported entries are reported at once so one retry fixes them.
 */
const parseManifest = (raw: unknown): Parsed<DeployManifest> => {
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
        const parsed = parseBinding(entry, index);

        if ("error" in parsed) {
            return parsed;
        }

        const { binding, type } = parsed.value;

        if (isUnsupported(type)) {
            unsupported.push(`${type} (${binding}): ${UNSUPPORTED_REASONS[type]}`);
        }

        bindings.push(parsed.value);
    }

    if (unsupported.length > 0) {
        return { error: `Lunora Cloud cannot provide these bindings — ${unsupported.join("; ")}` };
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
const resourceNameError = (alias: string, manifest: DeployManifest): string | undefined => {
    for (const requirement of manifest.bindings) {
        if (BINDING_SUPPORT[requirement.type] !== "provisioned") {
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

const parsePayload = (body: DeployBody, alias: string): Parsed<{ assets: AssetsUpload | undefined; manifest: DeployManifest }> => {
    // The script name is the project alias: it becomes the public subdomain and
    // keys every per-project resource, so it must be a shape that cannot collide.
    if (!ALIAS_PATTERN.test(alias)) {
        return { error: `scriptName must be lowercase letters and digits in dash-separated runs (${String(ALIAS_PATTERN)})` };
    }

    const manifest = parseManifest(body.manifest);

    if ("error" in manifest) {
        return manifest;
    }

    const nameError = resourceNameError(alias, manifest.value);

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
    write: (line: Record<string, unknown>) => void,
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

    // The worker bundle is prebuilt client-side (the app's Vite pipeline);
    // deploying without one would provision an empty module, so fail fast.
    if (!body.bundle) {
        return json(400, { error: "bundle is required (base64-encoded worker module)" });
    }

    const encodedBundle = body.bundle;
    const bundle = decodeBundle(encodedBundle);

    if (!bundle) {
        return json(400, { error: "bundle is not valid base64" });
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

    // Refused here, before a deployment row exists or anything is provisioned.
    const payload = parsePayload(body, body.scriptName);

    if ("error" in payload) {
        return json(400, { error: payload.error });
    }

    const { assets, manifest } = payload.value;
    const { branch, projectId, scriptName } = body;
    // Tenant cron expressions to fan out (§2.4). Defensive: only strings, capped.
    const cronSpecs = Array.isArray(body.cronSpecs) ? body.cronSpecs.filter((cron): cron is string => typeof cron === "string").slice(0, 50) : undefined;

    // The platform-minted tenant admin token: recorded on the deployment (for the
    // admin proxy) and set as the worker's LUNORA_ADMIN_TOKEN secret.
    const adminToken = randomSecret();

    let deploymentId: string;
    let previousDeploymentId: string | undefined;

    try {
        const created = await deps.backend.createDeployment({
            adminToken,
            branch,
            ...(cronSpecs && cronSpecs.length > 0 ? { cronSpecs } : {}),
            key,
            kind,
            organizationId: target.organizationId,
            projectId,
            scriptName,
        });

        deploymentId = created.deploymentId;
        previousDeploymentId = created.previousDeploymentId;
    } catch (error) {
        return json(403, { error: error instanceof Error ? error.message : "failed to record deployment" });
    }

    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
            const write = (line: Record<string, unknown>): void => {
                controller.enqueue(encoder.encode(`${JSON.stringify(line)}\n`));
            };

            /**
             * The one terminal-failure path: emit the failed phase + done frames,
             * best-effort mark the row failed, and close the stream. Extracted
             * because three call sites had to do all four steps in order, and a
             * missed one strands the row mid-flight with the client still hanging.
             */
            const failStream = async (error: unknown, fallback: string): Promise<void> => {
                write({ deploymentId, error: error instanceof Error ? error.message : fallback, phase: "failed" });

                try {
                    await deps.backend.updateStatus({ deploymentId, key, status: "failed" });
                } catch {
                    // The status write is the likeliest thing to have just failed;
                    // reporting the failure downstream matters more than recording it.
                }

                write({ deploymentId, done: true, status: "failed" });
                controller.close();
            };

            write({ deploymentId, event: "accepted" });

            // Stored BEFORE anything touches the Worker: this copy is what a later
            // rollback — or the revert below — puts back, so a release that is not
            // stored must never go live.
            try {
                await deps.releases.put(deploymentId, { ...(assets ? { assets } : {}), bundle: encodedBundle, manifest });
            } catch (error) {
                await failStream(new Error(`failed to store the release: ${error instanceof Error ? error.message : String(error)}`), "");

                return;
            }

            // Tenant env secrets are decrypted and merged in; LUNORA_ADMIN_TOKEN
            // is platform-owned and always wins over a same-named tenant secret.
            // A decrypt failure (e.g. a corrupt secret or a rotated master key)
            // must surface as a failed deployment, not leave the row stuck in
            // `accepted` — so transition to `failed` and close the stream.
            let tenantSecrets: Record<string, string>;

            try {
                tenantSecrets = (await deps.backend.resolveSecrets?.({ key, kind, organizationId: target.organizationId, projectId })) ?? {};
            } catch (error) {
                await failStream(error, "failed to resolve tenant secrets");

                return;
            }

            const spec = buildDeploymentSpec({
                adminToken,
                alias: scriptName,
                assets,
                bundle,
                cell: deps.cell,
                dispatchNamespace: deps.dispatchNamespace,
                kind,
                manifest,
                organizationId: target.organizationId,
                projectId,
                telemetry: await resolveTelemetrySafely(deps, { key, organizationId: target.organizationId }),
                tenantSecrets,
            });

            const { healthCheck } = deps;

            let outcome: Awaited<ReturnType<typeof runDeployment>>;

            try {
                outcome = await runDeployment(spec, {
                    onProgress: async (progress: DeployProgress) => {
                        write({ ...progress, deploymentId });

                        if (progress.phase === "provisioning" || progress.phase === "verifying" || progress.phase === "live" || progress.phase === "failed") {
                            await deps.backend.updateStatus({ bundleHash: progress.bundleHash, deploymentId, key, status: progress.phase, url: progress.url });
                        }
                    },
                    provisioner: deps.provisioner,
                    scheduler: deps.scheduler,
                    ...(healthCheck ? { verify: (result) => healthCheck(result.url) } : {}),
                });
            } catch (error) {
                // `runDeployment` converts provisioner/scheduler faults into
                // `{ status: "failed" }` itself, so reaching here means the *callback*
                // threw — an `updateStatus` write that failed, most likely. Without
                // this the rejection escapes `start`, the row is stranded mid-flight in
                // `accepted`/`provisioning` forever, and the NDJSON stream is never
                // closed, so the client hangs instead of seeing a failure.
                await failStream(error, "deployment failed");

                return;
            }

            if (outcome.status === "failed" && outcome.provisioned) {
                await revertFailedRelease({ deploymentId, key, organizationId: target.organizationId, previousDeploymentId }, deps, write);
            }

            // Health-checked release: record it live and supersede the previous
            // one (GAPS.md A1). An activation failure downgrades the release to
            // failed, but the Worker already runs it — the record is what lags.
            if (outcome.status === "live" && deps.backend.activateDeployment) {
                try {
                    await deps.backend.activateDeployment({ deploymentId, key });
                    write({ deploymentId, event: "released" });
                } catch (error) {
                    await failStream(error, "activation failed");

                    return;
                }
            }

            // Outcome, not progress: one event per deploy, carrying ids and a
            // status. Never the script, its bindings, or the tenant's URL.
            deps.analytics?.("cloud_deployment_finished", { deploymentId, kind, status: outcome.status });

            write({ deploymentId, done: true, status: outcome.status });
            controller.close();
        },
    });

    return new Response(stream, { headers: { "content-type": "application/x-ndjson", "x-accel-buffering": "no" }, status: 200 });
};

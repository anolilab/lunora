/**
 * Validating a release's payload: the binding manifest against the project's
 * target, and the static-asset upload against the manifest. Every refusal
 * happens here, before a deployment row exists or anything is provisioned, and
 * reads only the target's static tables (`BINDING_SUPPORT`,
 * `UNSUPPORTED_REASONS`) — never a driver.
 */
import { isReleaseAlias } from "@lunora/config/celld";

import type { AssetFile, AssetsUpload, BindingRequirement, BindingType, DeployManifest, TargetId } from "../provision-contract";
import { BINDING_SUPPORT, tenantResourceName, unsupportedReason } from "../provision-contract";

/**
 * Every Lunora tenant worker exports `ShardDO` (binding `SHARD`); without its
 * binding and the matching `new_sqlite_classes` migration tag the uploaded
 * dispatch script cannot boot. The floor is added whenever the manifest does
 * not already bind the class, so an under-declaring caller still comes up.
 */
const SHARD_DO_BINDING: BindingRequirement = { binding: "SHARD", className: "ShardDO", sqlite: true, type: "durable_object" };

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

/** Validation outcome: the parsed value, or the 400 message. */
type Parsed<T> = { error: string } | { value: T };

const isOneOf = <T extends string>(values: ReadonlyArray<T>, value: unknown): value is T =>
    typeof value === "string" && (values as ReadonlyArray<string>).includes(value);

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** Every table names every type `@lunora/config` emits, so any target's table answers "is this a binding type". */
const isBindingType = (value: string, target: TargetId): value is BindingType => Object.hasOwn(BINDING_SUPPORT[target], value);

/** Class-backed types the platform binds straight to an export of the tenant bundle. */
const needsClassName = (type: BindingType): boolean => type === "durable_object" || type === "workflow";

const parseBinding = (entry: unknown, index: number, target: TargetId): Parsed<BindingRequirement> => {
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
const parseManifest = (raw: unknown, target: TargetId): Parsed<DeployManifest> => {
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

        if (BINDING_SUPPORT[target][type] === "unsupported") {
            unsupported.push(`${type} (${binding}): ${unsupportedReason(target, type) ?? `not supported on ${target}`}`);
        }

        bindings.push(parsed.value);
    }

    if (unsupported.length > 0) {
        return { error: `Lunora Cloud cannot provide these bindings on the ${target} target — ${unsupported.join("; ")}` };
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
const resourceNameError = (alias: string, manifest: DeployManifest, target: TargetId): string | undefined => {
    for (const requirement of manifest.bindings) {
        if (BINDING_SUPPORT[target][requirement.type] !== "provisioned") {
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

export const parsePayload = (
    body: { assets?: unknown; manifest?: unknown },
    alias: string,
    target: TargetId,
): Parsed<{ assets: AssetsUpload | undefined; manifest: DeployManifest }> => {
    // The script name is the project alias: it becomes the public subdomain and
    // keys every per-project resource, so it must be a shape that cannot collide.
    if (!isReleaseAlias(alias)) {
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

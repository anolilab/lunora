/**
 * The read-only pre-deploy checks `lunora deploy` and `lunora prepare` share:
 * Docker and container sources, the D1 placeholder, localhost origins in vars,
 * and the `--migrate` preflight.
 */
import { existsSync } from "node:fs";

import { COMPOSED_WORKER_ENTRY, discoverContainerInfo } from "@lunora/config";
import type { WranglerConfig } from "@lunora/config/cloudflare";
import { findWranglerFile, mergeWranglerEnvironment, readWranglerJsonc } from "@lunora/config/cloudflare";
import { join } from "@visulima/path";

import type { DockerProbe } from "../../util/docker";
import { isDockerAvailable } from "../../util/docker";
import type { ExitCode } from "../../util/exit-code";
import { EXIT_CODE } from "../../util/exit-code";
import type { Logger } from "../../util/logger";
import type { DeployCommandOptions } from "./types";

/** Placeholder written by `reconcileWranglerBindings` for auto-provisioned D1 bindings. */
const D1_PLACEHOLDER_ID = "<replace-with-d1-create-id>";

interface WranglerD1Entry {
    binding?: string;
    database_id?: string;
}

interface WranglerD1Shape {
    containers?: ReadonlyArray<{ image?: string } | null | undefined>;
    d1_databases?: ReadonlyArray<WranglerD1Entry>;
    vars?: Record<string, unknown>;
}

/**
 * Normalise a raw binding array read out of hand-written JSONC: `undefined`
 * when it is not an array at all, otherwise the array with its nullish entries
 * dropped.
 *
 * `"d1_databases": [null]` passes an `Array.isArray` check, and the placeholder
 * gate below then dereferenced `entry.database_id` and threw a TypeError out of
 * a preflight — before `validateWrangler` got to report the malformed config
 * the user can actually act on. A malformed shape is the validator's error to
 * report, never a stack trace out of a gate, so the entries are dropped once
 * here rather than guarded at each reader.
 */
const bindingEntries = (value: unknown): unknown[] | undefined =>
    Array.isArray(value) ? (value as unknown[]).filter((entry) => entry !== null && entry !== undefined) : undefined;

/**
 * Find and parse the project's wrangler.jsonc **in the `--env` view wrangler
 * will deploy**; `undefined` when absent or unparseable.
 *
 * `vars`, `d1_databases` and `containers` are all non-inheritable in wrangler,
 * so `deploy --env staging` uses `env.staging`'s values and ignores the top
 * level entirely. Reading the top level here shipped an env-scoped placeholder
 * database_id / loopback origin silently, and falsely blocked the reverse
 * layout (dev values at the top, real ones in the env block). Shares
 * `mergeWranglerEnvironment` with the validator so both agree with wrangler.
 */
const readWranglerShape = (cwd: string, environment?: string): WranglerD1Shape | undefined => {
    const wranglerPath = findWranglerFile(cwd);

    if (!wranglerPath) {
        return undefined;
    }

    const { parsed } = readWranglerJsonc<WranglerConfig>(wranglerPath);

    if (parsed === undefined) {
        return undefined;
    }

    // An undeclared `--env` is the validator's error to report (it never reaches
    // the wrangler spawn), so fall back to the unmerged view rather than
    // duplicating that message from a preflight.
    const { error, merged } = mergeWranglerEnvironment(parsed, environment);
    // Read back as `unknown`: `WranglerConfig` describes a WELL-FORMED config,
    // but this is hand-written JSONC where `"d1_databases": {}` type-checks as
    // an array and then throws `.filter is not a function` inside a preflight.
    // Normalised once here rather than at each gate — a malformed shape is the
    // validator's error to report, never a stack trace out of a gate.
    const view = (error === undefined ? merged : parsed) as Record<string, unknown>;
    const { containers, d1_databases: databases, vars } = view;

    return {
        containers: bindingEntries(containers) as WranglerD1Shape["containers"],
        d1_databases: bindingEntries(databases) as WranglerD1Shape["d1_databases"],
        vars: typeof vars === "object" && vars !== null && !Array.isArray(vars) ? (vars as Record<string, unknown>) : undefined,
    };
};

/**
 * Every IPv4 loopback address, not just `127.0.0.1`: the whole `127.0.0.0/8`
 * block is loopback (RFC 1122), so `127.0.0.2` is exactly as unreachable from a
 * deployed Worker. Matched as a dotted quad rather than a `"127."` prefix,
 * because `127.example.com` is a routable DNS name and must not be blocked.
 *
 * The shorter numeric spellings need no pattern of their own — `new URL()`
 * canonicalises them for http(s), so `127.1`, `0x7f.1` and `2130706433` all
 * arrive here as `127.0.0.1`.
 */
const IPV4_LOOPBACK = /^127(?:\.\d{1,3}){3}$/;

/** True when a URL string resolves to a loopback host (localhost / 127.0.0.0/8 / ::1). */
const isLocalhostUrl = (value: string): boolean => {
    try {
        const { hostname } = new URL(value);

        return hostname === "localhost" || IPV4_LOOPBACK.test(hostname) || hostname === "::1" || hostname === "[::1]";
    } catch {
        return false;
    }
};

/** Mirrors the validator's heuristic: a container image that is a local path (vs a registry reference). */
const isLocalImagePath = (image: string): boolean => image.startsWith("./") || image.startsWith("../") || image.startsWith("/") || image.includes("Dockerfile");

/**
 * `wrangler deploy` builds and pushes a container image with the local Docker
 * engine whenever `containers[].image` points at a Dockerfile. Check that
 * prerequisite up front and return an actionable error instead of letting
 * wrangler fail mid-deploy with an opaque engine error. Returns `undefined`
 * when no local image build is needed or Docker is available.
 */
const checkContainerDockerPreflight = (
    cwd: string,
    logger: Logger,
    dockerAvailable: DockerProbe,
    command: PreDeployCommand = "deploy",
    environment?: string,
): string | undefined => {
    const localImages = (readWranglerShape(cwd, environment)?.containers ?? []).filter(
        (entry) => typeof entry?.image === "string" && isLocalImagePath(entry.image),
    );

    if (localImages.length === 0 || dockerAvailable()) {
        return undefined;
    }

    const message =
        `${command} blocked: wrangler.jsonc declares ${String(localImages.length)} container(s) built from a local Dockerfile, but no Docker-compatible ` +
        `engine is available. Start Docker (or Colima), or point the container's \`image\` at a pre-built registry reference. ` +
        `Note: container images must target linux/amd64.`;

    logger.error(message);

    return message;
};

/**
 * Resolve the worker entry `wrangler deploy` should bundle. Class-B frameworks
 * (SvelteKit, Astro) ship a CF adapter that owns the wrangler `main` field and
 * overwrites it with its own generated worker at build time — so `main` cannot
 * itself point at Lunora's composition. The template instead ships a
 * composed entry that imports that generated handler, wraps it with
 * `withLunora` (mounting `/_lunora/*`), and re-exports `ShardDO`. When that file
 * exists we pass it as the positional deploy entry so the ONE deployed worker is
 * the composed one — the positional argument overrides `main`. Class-A/C
 * templates have no composed entry (their `main` already points at the real
 * entry), so this returns `undefined` and `wrangler` uses `main` as usual.
 *
 * The path is {@link COMPOSED_WORKER_ENTRY}, imported rather than repeated:
 * `inferLunoraBindings` probes the same file to decide which classes are
 * provisioned, and a literal in each place is a divergence waiting to happen.
 */
const resolveComposedWorkerEntry = (cwd: string): string | undefined => (existsSync(join(cwd, COMPOSED_WORKER_ENTRY)) ? COMPOSED_WORKER_ENTRY : undefined);

/**
 * Verify every container's local build source exists before wrangler/railpack
 * runs. A Dockerfile/build-dir typo otherwise fails opaquely mid-deploy.
 * Registry images have no local source, so they're skipped. Returns the first
 * error message, or `undefined` when all sources exist (or none are local).
 */
const checkContainerSourcesExist = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy"): string | undefined => {
    for (const container of discoverContainerInfo(cwd, "lunora").containers) {
        const { image } = container;

        if (image.kind === "dockerfile" && !existsSync(join(cwd, image.dockerfilePath))) {
            const message = `${command} blocked: container "${container.exportName}" references a Dockerfile at "${image.dockerfilePath}" that does not exist. Create it or fix the \`image\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }

        if (image.kind === "build" && !existsSync(join(cwd, image.buildDir))) {
            const message = `${command} blocked: container "${container.exportName}" references a Railpack build directory "${image.buildDir}" that does not exist. Create it or fix the \`image.build\` path in lunora/containers.ts.`;

            logger.error(message);

            return message;
        }
    }

    return undefined;
};

/**
 * Return the name of any D1 binding that still carries the placeholder
 * database_id written by `reconcileWranglerBindings`. Returns `undefined`
 * when no placeholder is found (or when wrangler.jsonc is absent/unparseable —
 * the validator will report the real problem in that case).
 */
const findD1PlaceholderBinding = (cwd: string, environment?: string): string | undefined =>
    (readWranglerShape(cwd, environment)?.d1_databases ?? []).find((entry) => entry.database_id === D1_PLACEHOLDER_ID)?.binding;

/**
 * Validate the migration options that would otherwise fail only after the live
 * worker has already been replaced by `wrangler deploy`.
 */
const validateMigrateDeployPreflight = (options: DeployCommandOptions): string | undefined => {
    // A dry run / preview never publishes a live version, so post-deploy
    // migrations don't run — don't demand `--migrate-url`/`--migrate-yes` for a
    // `--dry-run --migrate` or `--preview --migrate` combo.
    if (!options.migrate || options.dryRun || options.preview) {
        return undefined;
    }

    // The deployed URL is only known AFTER wrangler runs, and this gate runs
    // before it — so there is nothing to default to here, and without an
    // explicit `--migrate-url` the downstream migration would fall back to
    // `http://localhost:8787` (the dev worker) and apply against LOCAL state —
    // and ship the production admin bearer to whatever listens on that port.
    // Refuse before deploying rather than silently targeting localhost later.
    // (A linked checkout satisfies this without the flag: the caller resolves
    // `migrateUrl` through `resolveWorkerUrl`, which reads the link this
    // deploy's predecessor recorded.)
    if (options.migrateUrl === undefined) {
        const message =
            "--migrate requires --migrate-url <https://your-worker> — the deploy target URL is only known after wrangler runs, and this gate runs before it; refusing to default to localhost";

        options.logger.error(message);

        return message;
    }

    if (options.migrateYes !== true) {
        const message = "--migrate runs production data migrations after deploy. Re-run with --migrate-yes to confirm.";

        options.logger.error(message);

        return message;
    }

    const migrateToken = options.migrateToken ?? process.env.LUNORA_ADMIN_TOKEN;

    if (migrateToken === undefined || migrateToken === "") {
        const message = "admin token required for --migrate — pass --migrate-token or set LUNORA_ADMIN_TOKEN";

        options.logger.error(message);

        return message;
    }

    return undefined;
};

/**
 * Check for a D1 placeholder database_id and return an error message when one
 * is found. Returns `undefined` when the config is clean (or absent/unparseable
 * — those cases fall through to the validator). Extracted from `runDeployCommand`
 * to keep its cognitive complexity within the 15-node budget.
 */
const checkD1Placeholder = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", environment?: string): string | undefined => {
    const placeholderBinding = findD1PlaceholderBinding(cwd, environment);

    if (placeholderBinding === undefined) {
        return undefined;
    }

    const message =
        `${command} blocked: the "${placeholderBinding}" D1 binding has a placeholder database_id ` +
        `("${D1_PLACEHOLDER_ID}"). Run \`wrangler d1 create <name>\` to create the database, ` +
        `then replace the placeholder in wrangler.jsonc with the real id before deploying.`;

    logger.error(message);

    return message;
};

/**
 * Hard-block a deploy when a worker-origin `var` still points at localhost.
 * `lunora deploy` always targets Cloudflare (the dev loop is `lunora dev`), and
 * a Worker can't reach a loopback address — so a localhost origin silently
 * breaks scheduled jobs / auth callbacks in production. Mirrors the
 * D1-placeholder hard-block. Returns the error message, or `undefined` when
 * clean (or when wrangler.jsonc is absent/unparseable — the validator handles
 * that).
 *
 * Checks every `var`, not a named subset — see the filter below.
 */
const checkLocalhostOriginVariables = (cwd: string, logger: Logger, command: PreDeployCommand = "deploy", environment?: string): string | undefined => {
    const variables = readWranglerShape(cwd, environment)?.vars;

    if (!variables) {
        return undefined;
    }

    // Every `var` whose value is a loopback URL, not a list of known names: the
    // invariant is a property of the VALUE (a deployed Worker cannot reach
    // loopback, whatever the var is called), and the allowlist this replaces had
    // already gone stale — it covered `LUNORA_ORIGIN_URL` and `AUTH_URL` while
    // `APP_BASE_URL` and `PUBLIC_STORAGE_BASE_URL` shipped localhost defaults
    // past it. A name list has to be extended by whoever adds the next origin
    // var, which is exactly the person who doesn't know this gate exists.
    const offenders = Object.entries(variables)
        .filter(([, value]) => typeof value === "string" && isLocalhostUrl(value))
        .map(([name]) => name)
        .toSorted((a, b) => a.localeCompare(b));

    if (offenders.length === 0) {
        return undefined;
    }

    const message =
        `${command} blocked: ${offenders.join(", ")} in wrangler.jsonc point at localhost. A deployed Worker can't reach a loopback ` +
        `address, so this silently breaks scheduled-job dispatch, reverse cross-shard relations, and auth callbacks. ` +
        `Set each to the deployed worker's public URL ` +
        `(or move it to a secret with \`wrangler secret put\`) before deploying.`;

    logger.error(message);

    return message;
};

/**
 * The commands that run the pre-deploy pipeline, as the OPERATOR typed them.
 *
 * These checks are reached from `lunora deploy`, `lunora prepare` and
 * `lunora build`, and a blocked run naming a command the operator never ran
 * reads as a bug in the tool rather than a problem in the project.
 *
 * `build` is one of them: it delegates to `runDeployCommand({ dryRun: true })`.
 * The name is threaded through rather than assumed, because the drift gate uses
 * it for two operator-facing decisions — which override flags to offer, and what
 * to call the thing that was blocked. Hardcoding `"deploy"` here meant `lunora
 * build` reported "deploy blocked" for a deploy nobody attempted and recommended
 * a flag `build` rejects with a raw stack trace.
 */
type PreDeployCommand = "build" | "deploy" | "prepare";

/**
 * The read-only half of the pre-deploy gates: the D1-placeholder hard-block, the
 * localhost-origin var check, and the container source + Docker preflights.
 * Returns the first error message, or `undefined` when all pass.
 *
 * Separate from the container BUILD so `lunora prepare` can run the checks
 * without it: building pushes images, which a command whose whole job is "tell me
 * whether this would deploy" must not do. `executeDeploy` runs both.
 */
const runPreDeployChecks = (cwd: string, options: DeployCommandOptions, command: PreDeployCommand): { code: ExitCode; error: string } | undefined => {
    const d1Error = checkD1Placeholder(cwd, options.logger, command, options.env);

    if (d1Error !== undefined) {
        return { code: EXIT_CODE.USAGE, error: d1Error };
    }

    const localhostOriginError = checkLocalhostOriginVariables(cwd, options.logger, command, options.env);

    if (localhostOriginError !== undefined) {
        return { code: EXIT_CODE.USAGE, error: localhostOriginError };
    }

    const sourceError = checkContainerSourcesExist(cwd, options.logger, command);

    if (sourceError !== undefined) {
        return { code: EXIT_CODE.USAGE, error: sourceError };
    }

    const dockerError = checkContainerDockerPreflight(cwd, options.logger, options.dockerAvailable ?? isDockerAvailable, command, options.env);

    // Not a usage error: the project is fine and the machine is not. Same bucket
    // `lunora containers build` already exits with for the same missing engine.
    return dockerError === undefined ? undefined : { code: EXIT_CODE.MISSING_DEPENDENCY, error: dockerError };
};

export type { PreDeployCommand };
export { resolveComposedWorkerEntry, runPreDeployChecks, validateMigrateDeployPreflight };

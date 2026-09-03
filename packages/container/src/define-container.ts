/**
 * `defineContainer` and the pure naming/normalization helpers shared by the
 * runtime, codegen, and the config layer. Everything here is Node-safe — no
 * Cloudflare runtime imports — so codegen and `@lunora/config` derive class
 * names, binding names, and wrangler image fields from the exact same logic
 * the runtime uses.
 */
import { LunoraError } from "@lunora/errors";

import type { ContainerConfig, ContainerDefinition, ContainerImageSource, NormalizedContainerImage } from "./types";

const NAMED_INSTANCE_TYPES = new Set(["basic", "lite", "standard-1", "standard-2", "standard-3", "standard-4"]);

const ENV_NAME_PATTERN = /^[A-Z_]\w*$/i;

/**
 * The string grammar `@cloudflare/containers`' `parseTimeExpression` accepts for
 * `sleepAfter`: a run of digits followed by a single `s`/`m`/`h` unit (e.g.
 * `"30s"`, `"5m"`, `"1h"`). Kept in lockstep with that parser's
 * `/^(\d+)([smh])$/`.
 */
const SLEEP_AFTER_PATTERN = /^\d+[smh]$/;

/** Seconds-per-unit for the `sleepAfter`/`hardTimeout` duration grammar. */
const DURATION_UNIT_SECONDS: Readonly<Record<string, number>> = { h: 3600, m: 60, s: 1 };

/**
 * Parse a `sleepAfter`/`hardTimeout` duration into whole seconds. A `number` is
 * treated as seconds (floored); a string follows the `<digits><s|m|h>` grammar
 * {@link SLEEP_AFTER_PATTERN} enforces. Shared by the runtime DO so the wire
 * value the container sees is derived from the exact same logic that validates
 * it. Throws on an unparseable string (already rejected by `defineContainer`).
 */
const parseDurationSeconds = (duration: number | string): number => {
    if (typeof duration === "number") {
        return Math.floor(duration);
    }

    const match = SLEEP_AFTER_PATTERN.exec(duration);

    if (match === null) {
        throw new TypeError(`Invalid duration "${duration}" — expected a number of seconds or "<n>[smh]"`);
    }

    return Number(duration.slice(0, -1)) * (DURATION_UNIT_SECONDS[duration.slice(-1)] ?? 1);
};

/** Last path segment of a `/`-separated path (input is posix-style config). */
const basename = (path: string): string => {
    const trimmed = path.endsWith("/") ? path.slice(0, -1) : path;
    const separatorIndex = trimmed.lastIndexOf("/");

    return separatorIndex === -1 ? trimmed : trimmed.slice(separatorIndex + 1);
};

/** Directory part of a `/`-separated path (`"."` when there is none). */
const dirname = (path: string): string => {
    const separatorIndex = path.lastIndexOf("/");

    return separatorIndex === -1 ? "." : path.slice(0, separatorIndex) || "/";
};

/**
 * Normalize a `ContainerImageSource` into the shape wrangler wants: a
 * Dockerfile path + build context for local builds, or a fully-qualified
 * reference for pre-built images.
 *
 * A local-path string whose basename starts with `Dockerfile` (so
 * `Dockerfile.dev` also counts) is used as-is with its directory as the build
 * context; any other path is treated as the build-context directory and the
 * Dockerfile is expected at `<dir>/Dockerfile`.
 */
const normalizeContainerImage = (image: ContainerImageSource): NormalizedContainerImage => {
    if (typeof image !== "string") {
        if ("build" in image) {
            const buildDirectory = image.build.endsWith("/") ? image.build.slice(0, -1) : image.build;

            return { buildDir: buildDirectory, kind: "build" };
        }

        return { kind: "registry", reference: image.registry };
    }

    if (basename(image).startsWith("Dockerfile")) {
        return { buildContext: dirname(image), dockerfilePath: image, kind: "dockerfile" };
    }

    const context = image.endsWith("/") ? image.slice(0, -1) : image;

    return { buildContext: context, dockerfilePath: `${context}/Dockerfile`, kind: "dockerfile" };
};

/**
 * The generated Container DO class name for a `lunora/containers.ts` export:
 * `transcoder` → `TranscoderContainer`. wrangler's `containers[].class_name`
 * and the Durable Object binding's `class_name` both reference it, so codegen
 * and the config layer MUST derive it identically — always via this helper.
 */
const containerClassName = (exportName: string): string => `${exportName.charAt(0).toUpperCase()}${exportName.slice(1)}Container`;

/**
 * The Durable Object binding name for a container export: `transcoder` →
 * `CONTAINER_TRANSCODER`, `imageResizer` → `CONTAINER_IMAGE_RESIZER`. The
 * `CONTAINER_` prefix namespaces these away from `SHARD`/`SESSION`/`SCHEDULER`
 * so a container export can never collide with the built-in bindings.
 */
const containerBindingName = (exportName: string): string => `CONTAINER_${exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "_").toUpperCase()}`;

/**
 * The local image tag a Railpack `{ build }` container is built and pushed
 * under: `transcoder` → `lunora-transcoder:build`. The config reconciler writes
 * it as the wrangler `containers[].image`, and `lunora deploy` builds that tag
 * with Railpack and `wrangler containers push`es it before deploying — so all
 * three derive the tag from this one helper and can never disagree.
 */
const containerBuildTag = (exportName: string): string => `lunora-${exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase()}:build`;

/**
 * Declare a container deployed alongside the app. Pure validation + branding:
 * codegen discovers the export, emits the Container DO class
 * (`_generated/containers.ts`), and wires the typed `ctx.containers` handle;
 * the config layer reconciles the wrangler `containers[]` entry and Durable
 * Object binding from the same definition.
 *
 * ```ts
 * // lunora/containers.ts
 * export const transcoder = defineContainer({
 *     image: "./containers/transcoder",
 *     defaultPort: 8080,
 *     instanceType: "standard-1",
 *     maxInstances: 5,
 * });
 * ```
 */
/** Validate the `image` source — a local path, a registry ref, or a Railpack build dir. */
const assertValidImage = (image: ContainerConfig["image"]): void => {
    if (typeof image === "string") {
        if (image.length === 0) {
            throw new TypeError("defineContainer: `image` must be a non-empty path or a { registry } reference");
        }

        // A colon never appears in the posix-style relative paths the config
        // expects, but it does in nearly every image reference ("repo:tag",
        // "…@sha256:…") — catch the common mistake of passing a reference as a
        // plain string before it reaches wrangler as a bogus Dockerfile path.
        if (image.includes(":")) {
            throw new TypeError(
                `defineContainer: \`image\` string "${image}" looks like a registry reference — pass it as { registry: "${image}" } instead. Plain strings are local Dockerfile paths.`,
            );
        }

        return;
    }

    if ("build" in image) {
        if (typeof image.build !== "string" || image.build.length === 0) {
            throw new TypeError("defineContainer: `image.build` must be a non-empty source directory for Railpack to build");
        }

        return;
    }

    if (typeof image.registry !== "string" || image.registry.length === 0) {
        throw new TypeError("defineContainer: `image.registry` must be a non-empty fully-qualified image reference");
    }
};

/**
 * Validate the `secretsStore` env → binding map: each env name must be a valid
 * env-var name, each binding a non-empty string, and no env name may collide
 * with an `env`/`secrets` source (which one would silently win at start).
 */
const assertValidSecretsStore = (config: ContainerConfig, envNames: ReadonlySet<string>, secretNames: ReadonlySet<string>): void => {
    for (const [envName, binding] of Object.entries(config.secretsStore ?? {})) {
        if (!ENV_NAME_PATTERN.test(envName)) {
            throw new TypeError(`defineContainer: secretsStore env name "${envName}" is not a valid environment variable name`);
        }

        if (typeof binding !== "string" || binding.trim().length === 0) {
            throw new TypeError(`defineContainer: \`secretsStore["${envName}"]\` must be a non-empty Secrets Store binding name`);
        }

        if (envNames.has(envName) || secretNames.has(envName)) {
            throw new TypeError(`defineContainer: "${envName}" is declared in both \`secretsStore\` and \`env\`/\`secrets\` — pick one source for the value`);
        }
    }
};

/**
 * Validate `env`/`buildArgs`/`secrets`/`secretsStore` naming and reject a name
 * declared by more than one source (where one would silently overwrite the
 * other at start). All name sets must be valid env-var names; the collisions
 * are rejected at authoring time so the runtime resolver never has to.
 */
const assertValidEnvAndSecrets = (config: ContainerConfig): void => {
    for (const name of Object.keys(config.env ?? {})) {
        if (!ENV_NAME_PATTERN.test(name)) {
            throw new TypeError(`defineContainer: env variable name "${name}" is not a valid environment variable name`);
        }
    }

    for (const name of Object.keys(config.buildArgs ?? {})) {
        if (!ENV_NAME_PATTERN.test(name)) {
            throw new TypeError(`defineContainer: buildArg name "${name}" is not a valid environment variable name`);
        }
    }

    const envNames = new Set(Object.keys(config.env ?? {}));
    const secretNames = new Set(config.secrets);

    for (const secret of config.secrets ?? []) {
        if (!ENV_NAME_PATTERN.test(secret)) {
            throw new TypeError(`defineContainer: secret name "${secret}" is not a valid environment variable name`);
        }

        if (envNames.has(secret)) {
            throw new TypeError(
                `defineContainer: "${secret}" is declared in both \`env\` and \`secrets\` — a secret would silently overwrite the static env value; pick one`,
            );
        }
    }

    assertValidSecretsStore(config, envNames, secretNames);
};

/** Validate a port is an integer in the TCP range, with a directed error naming the field. */
const assertValidPort = (port: number, field: string): void => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
        throw new TypeError(`defineContainer: \`${field}\` must be an integer in 1–65535 (got ${String(port)})`);
    }
};

/** Validate the optional `readyOn` application-readiness probes (path, port, and status). */
const assertValidReadyOnChecks = (config: ContainerConfig): void => {
    for (const check of config.readyOn ?? []) {
        if (typeof check.path !== "string" || check.path.trim().length === 0) {
            throw new TypeError("defineContainer: `readyOn[].path` must be a non-empty HTTP path string");
        }

        if (check.path !== check.path.trim()) {
            throw new TypeError("defineContainer: `readyOn[].path` must not have leading or trailing whitespace");
        }

        if (check.port !== undefined) {
            assertValidPort(check.port, "readyOn[].port");
        }

        if (check.status !== undefined && (!Number.isInteger(check.status) || check.status < 100 || check.status > 599)) {
            throw new TypeError(`defineContainer: \`readyOn[].status\` must be an HTTP status code in 100–599 (got ${String(check.status)})`);
        }
    }
};

/** Validate an optional `sleepAfter`/`hardTimeout` duration — seconds or the `<n>[smh]` grammar. */
const assertValidDuration = (duration: number | string | undefined, field: string): void => {
    if (duration === undefined) {
        return;
    }

    if (typeof duration === "string") {
        if (!SLEEP_AFTER_PATTERN.test(duration)) {
            throw new TypeError(`defineContainer: \`${field}\` string "${duration}" must be a number of seconds followed by a unit, e.g. "30s", "5m", or "1h"`);
        }
    } else if (!Number.isInteger(duration) || duration < 1) {
        throw new TypeError(
            `defineContainer: \`${field}\` must be a positive integer number of seconds or a duration string like "5m" (got ${String(duration)})`,
        );
    }
};

/** Validate the egress-firewall fields — host allow/deny lists and `interceptHttps`. */
const assertValidEgressFields = (config: ContainerConfig): void => {
    for (const field of ["allowedHosts", "deniedHosts"] as const) {
        const hosts = config[field];

        if (hosts?.some((host) => typeof host !== "string" || host.trim().length === 0)) {
            throw new TypeError(`defineContainer: \`${field}\` must be an array of non-empty hostname patterns`);
        }
    }

    if (config.interceptHttps !== undefined && typeof config.interceptHttps !== "boolean") {
        throw new TypeError("defineContainer: `interceptHttps` must be a boolean, or omitted");
    }
};

/**
 * Validate the runtime fields the generated class applies onto the `Container`
 * base after `super()` — multi-port, the egress firewall, and observability
 * `labels`. Caught here at authoring time rather than failing inside the
 * worker. Blank (whitespace-only) strings are rejected too, since they'd reach
 * the platform as bogus hostnames/paths.
 */
const assertValidContainerRuntimeFields = (config: ContainerConfig): void => {
    if (config.requiredPorts !== undefined) {
        if (config.requiredPorts.length === 0) {
            throw new TypeError("defineContainer: `requiredPorts` must be a non-empty array of ports, or omitted");
        }

        for (const port of config.requiredPorts) {
            assertValidPort(port, "requiredPorts[]");
        }
    }

    if (
        config.entrypoint !== undefined &&
        (config.entrypoint.length === 0 || config.entrypoint.some((part) => typeof part !== "string" || part.trim().length === 0))
    ) {
        throw new TypeError("defineContainer: `entrypoint` must be a non-empty array of non-empty strings, or omitted");
    }

    assertValidEgressFields(config);

    if (config.pingEndpoint !== undefined && (typeof config.pingEndpoint !== "string" || config.pingEndpoint.trim().length === 0)) {
        throw new TypeError("defineContainer: `pingEndpoint` must be a non-empty path string");
    }

    for (const [key, value] of Object.entries(config.labels ?? {})) {
        if (key.trim().length === 0 || typeof value !== "string") {
            throw new TypeError("defineContainer: `labels` must be a record of non-empty keys to string values");
        }
    }

    assertValidReadyOnChecks(config);
};

/**
 * `defineContainer` is part of the experimental `@lunora/container` API and may change without a major version bump.
 */
const defineContainer = (config: ContainerConfig): ContainerDefinition => {
    assertValidImage(config.image);

    if (config.defaultPort !== undefined) {
        assertValidPort(config.defaultPort, "defaultPort");
    }

    const stepPercentage = config.rollout?.stepPercentage;

    if (stepPercentage !== undefined && (!Number.isInteger(stepPercentage) || stepPercentage < 1 || stepPercentage > 100)) {
        throw new TypeError(`defineContainer: \`rollout.stepPercentage\` must be an integer in 1–100 (got ${String(stepPercentage)})`);
    }

    const gracePeriodSeconds = config.rollout?.gracePeriodSeconds;

    // Reaches wrangler as `rollout_active_grace_period` unchecked, where a
    // fractional or negative value is a deploy-time failure a long way from the
    // line that caused it. Only the shape is asserted: 0 (no grace period) is
    // meaningful, and this repo has no sourced upper bound to enforce — an
    // invented ceiling would be the more expensive mistake.
    if (gracePeriodSeconds !== undefined && (!Number.isInteger(gracePeriodSeconds) || gracePeriodSeconds < 0)) {
        throw new TypeError(`defineContainer: \`rollout.gracePeriodSeconds\` must be a non-negative integer (got ${String(gracePeriodSeconds)})`);
    }

    if (config.maxInstances !== undefined && (!Number.isInteger(config.maxInstances) || config.maxInstances < 1)) {
        throw new TypeError(`defineContainer: \`maxInstances\` must be a positive integer (got ${String(config.maxInstances)})`);
    }

    if (typeof config.instanceType === "string" && !NAMED_INSTANCE_TYPES.has(config.instanceType)) {
        throw new TypeError(
            `defineContainer: unknown \`instanceType\` "${config.instanceType}" — use one of ${[...NAMED_INSTANCE_TYPES].join(", ")}, or a custom { vcpu, memoryMib, diskMb } object`,
        );
    }

    assertValidDuration(config.sleepAfter, "sleepAfter");
    assertValidDuration(config.hardTimeout, "hardTimeout");
    assertValidEnvAndSecrets(config);
    assertValidContainerRuntimeFields(config);

    return { ...config, isLunoraContainer: true };
};

/**
 * True when a value is a `defineContainer` result (the runtime brand check).
 */
const isContainerDefinition = (value: unknown): value is ContainerDefinition =>
    typeof value === "object" && value !== null && (value as { isLunoraContainer?: unknown }).isLunoraContainer === true;

/**
 * The container's full environment at instance start: the static `env` block
 * plus every declared secret resolved from the Worker `env`. A declared secret
 * missing from the Worker env fails fast — starting the container without a
 * credential it was promised yields far worse errors downstream.
 */
const resolveContainerEnvVariables = (definition: ContainerDefinition, workerEnv: Record<string, unknown>, exportName?: string): Record<string, string> => {
    const resolved: Record<string, string> = { ...definition.env };

    for (const secret of definition.secrets ?? []) {
        const value = workerEnv[secret];

        if (typeof value !== "string") {
            const label = exportName === undefined ? "container" : `container "${exportName}"`;

            throw new LunoraError(
                "INTERNAL",
                `${label}: declared secret "${secret}" is not set on the Worker environment. Add it to .dev.vars for local dev and run \`wrangler secret put ${secret}\` for production.`,
            );
        }

        resolved[secret] = value;
    }

    return resolved;
};

export {
    containerBindingName,
    containerBuildTag,
    containerClassName,
    defineContainer,
    isContainerDefinition,
    normalizeContainerImage,
    parseDurationSeconds,
    resolveContainerEnvVariables as resolveContainerEnvVars,
};

/**
 * `defineContainer` and the pure naming/normalization helpers shared by the
 * runtime, codegen, and the config layer. Everything here is Node-safe — no
 * Cloudflare runtime imports — so codegen and `@cirrus/config` derive class
 * names, binding names, and wrangler image fields from the exact same logic
 * the runtime uses.
 */
import type { ContainerConfig, ContainerDefinition, ContainerImageSource, NormalizedContainerImage } from "./types";

const NAMED_INSTANCE_TYPES = new Set(["basic", "lite", "standard-1", "standard-2", "standard-3", "standard-4"]);

const ENV_NAME_PATTERN = /^[A-Z_]\w*$/i;

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
 * Dockerfile is expected at `&lt;dir>/Dockerfile`.
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
 * The generated Container DO class name for a `cirrus/containers.ts` export:
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
 * under: `transcoder` → `cirrus-transcoder:build`. The config reconciler writes
 * it as the wrangler `containers[].image`, and `cirrus deploy` builds that tag
 * with Railpack and `wrangler containers push`es it before deploying — so all
 * three derive the tag from this one helper and can never disagree.
 */
const containerBuildTag = (exportName: string): string => `cirrus-${exportName.replaceAll(/(?<=[a-z0-9])(?=[A-Z])/g, "-").toLowerCase()}:build`;

/**
 * Declare a container deployed alongside the app. Pure validation + branding:
 * codegen discovers the export, emits the Container DO class
 * (`_generated/containers.ts`), and wires the typed `ctx.containers` handle;
 * the config layer reconciles the wrangler `containers[]` entry and Durable
 * Object binding from the same definition.
 *
 * ```ts
 * // cirrus/containers.ts
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

const defineContainer = (config: ContainerConfig): ContainerDefinition => {
    assertValidImage(config.image);

    if (config.defaultPort !== undefined && (!Number.isInteger(config.defaultPort) || config.defaultPort < 1 || config.defaultPort > 65_535)) {
        throw new TypeError(`defineContainer: \`defaultPort\` must be an integer in 1–65535 (got ${String(config.defaultPort)})`);
    }

    if (config.maxInstances !== undefined && (!Number.isInteger(config.maxInstances) || config.maxInstances < 1)) {
        throw new TypeError(`defineContainer: \`maxInstances\` must be a positive integer (got ${String(config.maxInstances)})`);
    }

    if (typeof config.instanceType === "string" && !NAMED_INSTANCE_TYPES.has(config.instanceType)) {
        throw new TypeError(
            `defineContainer: unknown \`instanceType\` "${config.instanceType}" — use one of ${[...NAMED_INSTANCE_TYPES].join(", ")}, or a custom { vcpu, memoryMib, diskMb } object`,
        );
    }

    for (const secret of config.secrets ?? []) {
        if (!ENV_NAME_PATTERN.test(secret)) {
            throw new TypeError(`defineContainer: secret name "${secret}" is not a valid environment variable name`);
        }
    }

    return { ...config, isCirrusContainer: true };
};

/** True when a value is a `defineContainer` result (the runtime brand check). */
const isContainerDefinition = (value: unknown): value is ContainerDefinition =>
    typeof value === "object" && value !== null && (value as { isCirrusContainer?: unknown }).isCirrusContainer === true;

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

            throw new Error(
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
    resolveContainerEnvVariables as resolveContainerEnvVars,
};

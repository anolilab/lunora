/**
 * Public configuration types for `@cirrus/container`.
 *
 * Everything in this module is pure data — no Cloudflare runtime imports — so
 * it is safe to import from Node tooling (codegen, the config layer) as well
 * as from worker code.
 */

/** Named instance types Cloudflare Containers provides. */
type NamedContainerInstanceType = "basic" | "lite" | "standard-1" | "standard-2" | "standard-3" | "standard-4";

/**
 * A custom instance type. Cloudflare's bounds at the time of writing: up to
 * 4 vCPU, 12 GiB memory, 20 GB disk, ≥ 3 GiB memory per vCPU and ≤ 2 GB disk
 * per GiB memory. The config-layer validator enforces the documented ranges.
 */
interface CustomContainerInstanceType {
    /** Disk in MB. Cloudflare's default is 2000 (2 GB). */
    diskMb?: number;
    /** Memory in MiB. Cloudflare's default is 256. */
    memoryMib?: number;
    /** vCPU count. Cloudflare's default is 0.0625 (1/16 vCPU). */
    vcpu?: number;
}

type ContainerInstanceType = CustomContainerInstanceType | NamedContainerInstanceType;

/**
 * A pre-built image pulled from a registry — the Cloudflare Registry, Docker
 * Hub, or Amazon ECR (the registries `wrangler deploy` supports). The
 * reference must be fully qualified, e.g. `docker.io/acme/transcoder:1.4`.
 */
interface RegistryImageSource {
    registry: string;
}

/**
 * Where the container image comes from. A `string` is a **local path** —
 * either a directory containing a `Dockerfile` (normalized to
 * `&lt;dir>/Dockerfile` with the directory as the build context) or a path to
 * the Dockerfile itself — while `{ registry }` is a pre-built image reference.
 */
type ContainerImageSource = RegistryImageSource | string;

interface ContainerConfig {
    /**
     * The port the container listens on. Worker → container requests target
     * this port. Locally the Dockerfile must also `EXPOSE` it.
     */
    defaultPort?: number;

    /**
     * Whether the container may open outbound internet connections. Defaults
     * to `true` — the platform default. Note that container egress is billed
     * per GB by Cloudflare.
     */
    enableInternet?: boolean;

    /**
     * Static environment variables passed to the container on every start.
     * For secret values use {@link ContainerConfig.secrets} instead so they
     * flow through Worker Secrets rather than source code.
     */
    env?: Readonly<Record<string, string>>;

    /** Image source — a local Dockerfile path/directory or a registry reference. */
    image: ContainerImageSource;

    /**
     * Resource class for each instance: a named Cloudflare instance type or a
     * custom `{ vcpu, memoryMib, diskMb }` object.
     */
    instanceType?: ContainerInstanceType;

    /**
     * Maximum number of concurrently *running* instances. Stopped (slept)
     * containers don't count. Also the default pool size for `.any()`.
     */
    maxInstances?: number;

    /**
     * Override for the wrangler `containers[].name` identifier. Defaults to
     * wrangler's own default (worker name + class name + environment).
     */
    name?: string;

    /**
     * Names of Worker secrets (from `wrangler secret` / `.dev.vars`) forwarded
     * into the container's environment at instance start. Each declared name
     * must exist on the Worker `env` — a missing one fails fast with a
     * directed error instead of starting the container without it.
     */
    secrets?: ReadonlyArray<string>;

    /**
     * Idle timeout after which the instance is put to sleep, e.g. `"5m"`,
     * `"30s"`, or a number of seconds. Cloudflare's default is `"10m"`.
     */
    sleepAfter?: number | string;
}

/**
 * The value `defineContainer` returns: the validated config plus a brand the
 * codegen discovery and the generated Container DO class key on.
 */
interface ContainerDefinition extends ContainerConfig {
    /** Brand marking a value as a Cirrus container definition. */
    readonly isCirrusContainer: true;
}

/** A normalized image source, as written into `wrangler.jsonc`. */
type NormalizedContainerImage =
    | {
          /** Build context directory (wrangler `image_build_context`). */
          buildContext: string;
          /** Path to the Dockerfile (wrangler `image`). */
          dockerfilePath: string;
          kind: "dockerfile";
      }
    | {
          kind: "registry";
          /** Fully-qualified image reference (wrangler `image`). */
          reference: string;
      };

export type {
    ContainerConfig,
    ContainerDefinition,
    ContainerImageSource,
    ContainerInstanceType,
    CustomContainerInstanceType,
    NamedContainerInstanceType,
    NormalizedContainerImage,
    RegistryImageSource,
};

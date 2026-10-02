/**
 * Public configuration types for `@lunora/container`.
 *
 * Everything in this module is pure data — no Cloudflare runtime imports — so
 * it is safe to import from Node tooling (codegen, the config layer) as well
 * as from worker code.
 */

/**
 * Named instance types Cloudflare Containers provides.
 */
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

/**
 * `ContainerInstanceType` is part of the experimental `@lunora/container` API and may change without a major version bump.
 */
type ContainerInstanceType = CustomContainerInstanceType | NamedContainerInstanceType;

/**
 * An instance size a Durable Object can pick at start under the
 * `durable_object` scheduling policy. The runtime does not accept `basic` (or
 * the legacy `dev`/`standard` aliases), and a custom size must set all three
 * fields — it is passed to `ctx.container.start({ instance })` as-is.
 */
type ContainerRuntimeInstanceType = Exclude<NamedContainerInstanceType, "basic"> | Required<CustomContainerInstanceType>;

/**
 * One named image under the `durable_object` scheduling policy. A `string` is
 * a local Dockerfile path or directory, built and uploaded by `wrangler deploy`
 * (wrangler `dockerfile` + `build_context`); `{ registry }` must be a
 * digest-pinned (`@sha256:…`) reference under `registry.cloudflare.com/`,
 * the Cloudflare managed registry — Cloudflare does not accept Docker Hub, ECR
 * or Artifact Registry references here.
 */
type ContainerNamedImageSource = RegistryImageSource | string;

/**
 * Rolling-deploy tuning for a container.
 */
interface ContainerRollout {
    /** Seconds an active instance runs before it's eligible for update (wrangler `rollout_active_grace_period`). */
    gracePeriodSeconds?: number;
    /** Percentage of instances updated per rollout step, 1–100 (wrangler `rollout_step_percentage`). */
    stepPercentage?: number;
}

/**
 * A pre-built image pulled from a registry — the Cloudflare Registry, Docker
 * Hub, or Amazon ECR (the registries `wrangler deploy` supports). The
 * reference must be fully qualified, e.g. `docker.io/acme/transcoder:1.4`.
 */
interface RegistryImageSource {
    registry: string;
}

/**
 * A Dockerfile-less build via [Railpack](https://railpack.com): point at a
 * source directory and `lunora deploy` builds an OCI image with Railpack
 * (needs a BuildKit instance) and pushes it to the Cloudflare Registry before
 * wrangler runs. Opt-in — the Dockerfile path is the zero-extra-deps default.
 */
interface BuildImageSource {
    build: string;
}

/**
 * Where the container image comes from. A `string` is a **local path** —
 * either a directory containing a `Dockerfile` (normalized to
 * `<dir>/Dockerfile` with the directory as the build context) or a path to
 * the Dockerfile itself — while `{ registry }` is a pre-built image reference.
 */
type ContainerImageSource = BuildImageSource | RegistryImageSource | string;

/**
 * An application-level readiness probe that gates request proxying. Layered on
 * top of the platform's own port/`pingEndpoint` health wait, it lets you hold
 * traffic back until the app inside the container is *functionally* ready —
 * migrations applied, caches warmed — which an open-port check can't see.
 *
 * Declarative on purpose: a `defineContainer` value stays pure data (no handler
 * functions), so codegen and the config layer can read it without evaluating
 * code. (Upstream cloudflare/containers#188 expresses the same idea as handler
 * functions; the Lunora config is data-only, so it's modelled as descriptors.)
 */
interface ContainerReadinessCheck {
    /** HTTP path probed on the container, e.g. `"/ready"` (a leading slash is optional). */
    path: string;
    /** Port to probe. Defaults to {@link ContainerConfigBase.defaultPort}. */
    port?: number;
    /** HTTP status that means "ready". Defaults to `200`. */
    status?: number;
}

/**
 * The fields every container accepts, whichever scheduling policy it uses.
 */
interface ContainerConfigBase {
    /**
     * Hostnames the container may reach **even when {@link ContainerConfigBase.enableInternet}
     * is `false`** — an egress allow-list (Cloudflare's `allowedHosts`). Glob
     * patterns like `*.stripe.com` are supported. Pair with `enableInternet:
     * false` to deny all egress except these hosts (the firewall pattern
     * upstream issue cloudflare/containers#30 asked for). The interception path
     * needs the `ContainerProxy` worker entrypoint, which codegen re-exports
     * from the generated container file automatically; the named-instance
     * handle's `egress` controls adjust the lists at runtime.
     */
    allowedHosts?: ReadonlyArray<string>;

    /**
     * Build-time variables for a Dockerfile/Railpack image — wrangler's
     * `image_vars` (equivalent to `docker build --build-arg`). For *runtime*
     * values use {@link ContainerConfigBase.env} / {@link ContainerConfigBase.secrets}.
     * Ignored for a pre-built `{ registry }` image.
     */
    buildArgs?: Readonly<Record<string, string>>;

    /**
     * The port the container listens on. Worker → container requests target
     * this port. Locally the Dockerfile must also `EXPOSE` it. For a
     * multi-port container also declare {@link ContainerConfigBase.requiredPorts}
     * and route per request with the handle's `.port(n)`.
     */
    defaultPort?: number;

    /**
     * Hostnames the container may **never** reach — an egress deny-list
     * (Cloudflare's `deniedHosts`). Overrides everything else, including
     * `enableInternet: true` and {@link ContainerConfigBase.allowedHosts}. Glob
     * patterns like `*.evil.com` are supported.
     */
    deniedHosts?: ReadonlyArray<string>;

    /**
     * Whether the container may open outbound internet connections. Defaults
     * to `true` — the platform default. Note that container egress is billed
     * per GB by Cloudflare. Combine with {@link ContainerConfigBase.allowedHosts} /
     * {@link ContainerConfigBase.deniedHosts} for a precise egress firewall.
     */
    enableInternet?: boolean;

    /**
     * Default command to run inside the container, overriding the image's
     * `ENTRYPOINT`/`CMD` (Cloudflare's `entrypoint`). A per-start override is
     * still available via the named-instance handle's `start({ entrypoint })`.
     */
    entrypoint?: ReadonlyArray<string>;

    /**
     * Static environment variables passed to the container on every start.
     * For secret values use {@link ContainerConfigBase.secrets} instead so they
     * flow through Worker Secrets rather than source code.
     */
    env?: Readonly<Record<string, string>>;

    /**
     * Hard cap on how long an instance may run, measured from start regardless
     * of activity — a runaway-cost backstop on top of the idle
     * {@link ContainerConfigBase.sleepAfter}. Same grammar as `sleepAfter`
     * (`"30s"`, `"5m"`, `"1h"`, or a plain number of seconds). When it elapses,
     * the `LunoraContainer.onHardTimeoutExpired` hook runs (default: `stop()`,
     * which sends SIGTERM and does not escalate — a container that ignores the
     * signal outlives its cap unless the hook is overridden to follow up with
     * `destroy()`). (Upstream cloudflare/containers#85.)
     */
    hardTimeout?: number | string;

    /**
     * Intercept the container's outbound **HTTPS** traffic so the egress
     * allow/deny lists apply to TLS connections too (Cloudflare's
     * `interceptHttps`). Requires the image to trust the Cloudflare CA at
     * `/etc/cloudflare/certs/cloudflare-containers-ca.crt`. Defaults to `false`
     * (HTTP egress is gated regardless).
     */
    interceptHttps?: boolean;

    /**
     * Key-value metadata attached to every instance for metrics/observability
     * (Cloudflare's container `labels`), e.g. `{ tenant: "acme", env: "prod" }`.
     * A per-start override is available via the named-instance handle's
     * `start({ labels })`.
     */
    labels?: Readonly<Record<string, string>>;

    /**
     * Override for the wrangler `containers[].name` identifier. Defaults to
     * wrangler's own default (worker name + class name + environment).
     */
    name?: string;

    /**
     * HTTP path Cloudflare polls to decide an instance is healthy
     * (Cloudflare's `pingEndpoint`). Defaults to upstream's slash-less `"ping"`;
     * either `"ping"` or `"/healthz"`-style paths are accepted. Set this when
     * the container exposes its readiness check under a different route.
     */
    pingEndpoint?: string;

    /**
     * Application-level readiness probes that gate request proxying: a
     * `ctx.containers.<name>` fetch waits until every probe responds with its
     * expected status before the request reaches the container — on top of the
     * platform's port/`pingEndpoint` health wait. All probes run in parallel.
     * Use these for readiness an open-port check can't see (migrations applied,
     * caches warm). (Upstream cloudflare/containers#188.)
     */
    readyOn?: ReadonlyArray<ContainerReadinessCheck>;

    /**
     * Ports the container must be listening on before it's considered ready
     * (Cloudflare's `requiredPorts`) — for multi-port containers. Start-up
     * waits for every listed port, and the handle's `.port(n)` routes a request
     * to any of them; {@link ContainerConfigBase.defaultPort} is the target when a
     * request doesn't pick one.
     */
    requiredPorts?: ReadonlyArray<number>;

    /**
     * Opt in to the Sandbox SDK helpers (`@cloudflare/sandbox`): structured
     * file operations, directory backups to R2 and S3-compatible bucket mounts
     * on a named instance. The image must ship the `sandbox-shim` helper at
     * `/usr/local/bin/sandbox-shim` — base it on Cloudflare's `cloudflare/sandbox`
     * image. Turning it on also makes codegen export the `S3Gateway` and
     * `DirectoryBackupGateway` entrypoints from the worker, which the helpers
     * route the container's storage traffic through. Must be a `true`/`false`
     * literal, because codegen reads it. Defaults to `false`.
     */
    sandbox?: boolean;

    /**
     * Names of Worker secrets (from `wrangler secret` / `.dev.vars`) forwarded
     * into the container's environment at instance start. Each declared name
     * must exist on the Worker `env` — a missing one fails fast with a
     * directed error instead of starting the container without it.
     */
    secrets?: ReadonlyArray<string>;

    /**
     * Cloudflare **Secrets Store** secrets forwarded into the container's
     * environment, as a map of *container env-var name → Worker Secrets Store
     * binding name*. Each binding is resolved with its async `.get()` the first
     * time the instance starts, then injected as that env var — e.g.
     * `{ STRIPE_KEY: "STRIPE_SECRET" }` runs `env.STRIPE_SECRET.get()` and sets
     * `STRIPE_KEY` inside the container. Unlike {@link ContainerConfigBase.secrets}
     * (plain Worker text secrets), this pulls from a `secrets_store_secrets`
     * binding. A name already used by `env`/`secrets` is rejected at authoring
     * time; a missing binding or unreadable value fails the start. Applies
     * to the default start (the `ctx.containers` proxy path and a bare
     * `start()`); a persisted per-instance `start({ envVars })` replaces the env
     * set wholesale, as it does for `env`/`secrets`. (Upstream
     * cloudflare/containers#96.)
     */
    secretsStore?: Readonly<Record<string, string>>;

    /**
     * Idle timeout after which the instance is put to sleep, e.g. `"5m"`,
     * `"30s"`, or a number of seconds. Cloudflare's default is `"10m"`.
     */
    sleepAfter?: number | string;
}

/**
 * A container under the `default` scheduling policy: one application-wide
 * image and instance size, set in wrangler and rolled out by Cloudflare on
 * deploy.
 */
interface DefaultScheduledContainerConfig extends ContainerConfigBase {
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
     * Rolling-deploy tuning. `stepPercentage` is the share of instances updated
     * per rollout step (wrangler `rollout_step_percentage`); `gracePeriodSeconds`
     * is how long an active instance is left running before it's eligible for
     * update (wrangler `rollout_active_grace_period`).
     */
    rollout?: ContainerRollout;

    /**
     * Where the image and instance size are configured. `"default"` (the
     * default) sets them once in wrangler; `"durable_object"` is the
     * per-instance policy.
     * Immutable once deployed: switching policies means a new container
     * application, which replaces every running instance.
     */
    schedulingPolicy?: "default";
}

/**
 * A container under the `durable_object` scheduling policy (Cloudflare public
 * beta): each instance picks its image and size when it starts, via
 * `ctx.containers.<name>.get(id).start({ image, instanceType })`, and can save
 * and restore its filesystem with `snapshot()` / `start({ snapshot })`.
 * Instances keep the image they started with across deploys — there is no
 * application-wide rollout, and no `maxInstances` cap (running instances count
 * against the account limit).
 */
interface DurableObjectScheduledContainerConfig extends ContainerConfigBase {
    /**
     * The image a start uses when it names none — including the implicit start a
     * `fetch`/`exec` triggers. Either a key of `images`
     * or a Cloudflare-managed image such as `"cloudflare/debian-trixie"`.
     * Without it, an instance must be started explicitly with an `image` (or a
     * `snapshot`) before it can serve requests.
     */
    image?: string;

    /**
     * Named images an instance can start from, keyed by the name `start({ image })`
     * takes (wrangler `containers[].images`). Up to 100, each name 1–128
     * characters. Updating the map does not restart running instances.
     */
    images?: Readonly<Record<string, ContainerNamedImageSource>>;

    /**
     * The instance size a start uses when it names none. Cloudflare's runtime
     * default is `"lite"`.
     */
    instanceType?: ContainerRuntimeInstanceType;

    /** Selects the per-instance policy. Immutable once deployed. */
    schedulingPolicy: "durable_object";
}

/**
 * `ContainerConfig` is part of the experimental `@lunora/container` API and may change without a major version bump.
 */
type ContainerConfig = DefaultScheduledContainerConfig | DurableObjectScheduledContainerConfig;

/**
 * The value `defineContainer` returns: the validated config plus a brand the
 * codegen discovery and the generated Container DO class key on.
 */
type ContainerDefinition = ContainerConfig & {
    /** Brand marking a value as a Lunora container definition. */
    readonly isLunoraContainer: true;
};

/**
 * A saved container filesystem, as `snapshot()` returns it. Plain data: store
 * it anywhere and pass it back to `start({ snapshot })`, from the same or
 * another instance of the same container. Tied to the image it was taken
 * from; Cloudflare keeps it 30 days, refreshed on each restore.
 */
interface ContainerSnapshot {
    id: string;
    name?: string;
    /** Size in bytes. */
    size: number;
}

/**
 * A normalized image source, as written into `wrangler.jsonc`.
 */
type NormalizedContainerImage =
    | {
          /** Build context directory (wrangler `image_build_context`). */
          buildContext: string;
          /** Path to the Dockerfile (wrangler `image`). */
          dockerfilePath: string;
          kind: "dockerfile";
      }
    | {
          /** Railpack source directory built + pushed at deploy time. */
          buildDir: string;
          kind: "build";
      }
    | {
          kind: "registry";
          /** Fully-qualified image reference (wrangler `image`). */
          reference: string;
      };

export type {
    BuildImageSource,
    ContainerConfig,
    ContainerConfigBase,
    ContainerDefinition,
    ContainerImageSource,
    ContainerInstanceType,
    ContainerNamedImageSource,
    ContainerReadinessCheck,
    ContainerRollout,
    ContainerRuntimeInstanceType,
    ContainerSnapshot,
    CustomContainerInstanceType,
    DefaultScheduledContainerConfig,
    DurableObjectScheduledContainerConfig,
    NamedContainerInstanceType,
    NormalizedContainerImage,
    RegistryImageSource,
};

/**
 * `DeployDriver` — the provider-neutral seam between what an app needs and
 * how a host provides it (plan 114, §5.3).
 *
 * Configuration inference is two jobs welded together today. Deciding that an
 * app needs a shard namespace, a queue, and an object-storage bucket is
 * host-neutral: it falls out of the app's schema and imports, and every target
 * reaches the same conclusion. Writing `durable_objects.bindings[]` into a
 * `wrangler.jsonc` is not — it is one host's encoding of that conclusion.
 *
 * The split here names both halves. {@link ResourceGraph} is the neutral answer
 * to "what does this app need?"; a {@link DeployDriver} turns that graph into
 * one host's configuration and owns the host's toolchain surface. A second
 * target implements the driver rather than forking the inference.
 *
 * Only the Cloudflare driver exists today (`cloudflare-driver.ts`), and it is
 * deliberately thin: it delegates to the same `inferLunoraBindings` /
 * `reconcileWrangler*` functions the CLI called directly before, so routing a
 * command through the driver is behavior-preserving by construction.
 *
 * The second half is the **toolchain surface**: which command a host runs to
 * deploy, serve, tail, or set a secret. A driver only *describes* that command
 * ({@link ToolchainCommand}); it never spawns. The CLI keeps ownership of
 * running it — package-manager resolution (`pnpm exec` / `npx --` / `bun x`)
 * and the injected spawner its tests substitute — so the driver stays free of
 * process concerns and remains trivially testable as a pure function.
 *
 * Each request type below is deliberately neutral: `preview`, `environment`,
 * `temporary` are concepts, not wrangler flags. A second host maps the same
 * request onto its own CLI without the caller changing.
 */

/** A durable, single-writer shard namespace (a Durable Object namespace on Cloudflare). */
export interface ShardNamespaceResource {
    /** The implementing class name the host binds to. */
    className: string;
    /** Whether the worker entry re-exports the class — an unexported class cannot be bound. */
    exported: boolean;
    /** The binding name the app reaches it through (e.g. `SHARD`). */
    name: string;
}

/** A named resource the app declares and the host must provision (queue, workflow, container). */
export interface NamedResource {
    /** Whether the declaration is re-exported from the worker entry, where that applies. */
    exported?: boolean;
    /** The declared name. */
    name: string;
}

/**
 * The provider-neutral statement of what an app needs, derived from its schema
 * and imports. Every field is a *requirement*, not a host encoding: a driver
 * decides what `objectStorage: true` means for its target.
 */
export interface ResourceGraph {
    /** Container images the app declares. */
    containers: ReadonlyArray<NamedResource>;
    /** Cron expressions the app schedules. */
    crons: ReadonlyArray<string>;

    /**
     * The app declares a `.global()` table, so it needs a replicated SQL store
     * (D1 on Cloudflare; Aurora/RDS elsewhere).
     */
    globalDatabase: boolean;
    /** The app reads or writes a key-value store. */
    keyValueStore: boolean;
    /** The app needs object storage (R2 on Cloudflare; S3-compatible elsewhere). */
    objectStorage: boolean;
    /** Queues the app declares. */
    queues: ReadonlyArray<NamedResource>;
    /** Shard namespaces the app needs. */
    shardNamespaces: ReadonlyArray<ShardNamespaceResource>;

    /**
     * Human-readable provenance for each requirement — why inference concluded
     * the app needs it. Surfaced in CLI logs; never load-bearing.
     */
    signals: ReadonlyArray<string>;
    /** Workflows the app declares. */
    workflows: ReadonlyArray<NamedResource>;
}

/** The outcome of writing a {@link ResourceGraph} into a host's configuration. */
export interface ProvisionResult {
    /** Short labels for each resource written, for logging. */
    added: ReadonlyArray<string>;
    /** Whether the host's configuration file was rewritten. */
    changed: boolean;
    /** Resolved configuration path, when the host has one. */
    configPath?: string;
    /** Non-fatal hints for requirements the driver cannot auto-provision. */
    warnings: ReadonlyArray<string>;
}

/**
 * A host CLI invocation, described but not run.
 *
 * `tool` is the binary name only (`"wrangler"`); the caller resolves how to
 * execute it through the project's package manager. Keeping that split means a
 * driver never has to know whether the project uses pnpm, npm, yarn, or bun.
 */
export interface ToolchainCommand {
    /** Arguments for {@link ToolchainCommand.tool}. */
    args: ReadonlyArray<string>;
    /** The host CLI binary, e.g. `"wrangler"`. */
    tool: string;
}

/** Neutral options for a deploy. */
export interface DeployRequest {
    /** Validate and bundle without publishing — nothing ships. */
    dryRun?: boolean;
    /** Deploy this entry file instead of the host config's default (framework composition). */
    entry?: string;
    /** Named deployment environment, when the host supports them. */
    environment?: string;
    /** Write the built bundle (and any build metadata) to this directory. */
    outDir?: string;
    /** Upload a preview/versioned artifact instead of taking production traffic. */
    preview?: boolean;
    /** Deploy to a short-lived, unauthenticated account where the host offers one. */
    temporary?: boolean;
}

/** Neutral options for a local dev server. */
export interface DevRequest {
    /** Host config file to run against, when the flow uses a generated one. */
    configPath?: string;
    /** Named environment. */
    environment?: string;
    /** Extra host-specific flags the caller has already resolved. */
    extraArgs?: ReadonlyArray<string>;
}

/** Neutral options for tailing live logs. */
export interface TailRequest {
    /** Named environment. */
    environment?: string;
    /** Output format the host tail supports (`"json"`, `"pretty"`, …). */
    format?: string;
    /** Free-text filter. */
    search?: string;
    /** Status filter (`"error"`, `"ok"`, …). */
    status?: string;
    /** Tail a short-lived account's deployment. */
    temporary?: boolean;
    /** Tail a specific deployed worker/service by name, when the host addresses them individually. */
    worker?: string;
}

/** Neutral options for reading or writing deployment secrets. */
export interface SecretRequest {
    /** Named environment. */
    environment?: string;
    /** The secret's name — required for `put`, unused for `list`. */
    key?: string;
    /** Operate against a short-lived account. */
    temporary?: boolean;
}

/**
 * The host's command-line surface. Optional as a whole: a host with no CLI (a
 * hypothetical API-driven target) implements `infer`/`provision` only, and the
 * caller falls back to its own handling.
 */
export interface DriverToolchain {
    /** The command that deploys the app. */
    deploy: (request: DeployRequest) => ToolchainCommand;
    /** The command that runs a local dev server. */
    dev: (request: DevRequest) => ToolchainCommand;

    /**
     * The command that lists remote secret names, or `undefined` for a target
     * with no such step.
     *
     * Optional because not every target manages secrets through a CLI: an
     * IaC-backed one declares them as resources inside its program, so there is
     * no separate command to run. Absent means "this target has no CLI for
     * this", which a caller must report rather than paper over — silently
     * skipping a secret push would look like success.
     */
    secretList?: (request: SecretRequest) => ToolchainCommand | undefined;

    /** The command that writes one secret, or `undefined`. Its value is passed on stdin, never argv. See {@link DriverToolchain.secretList}. */
    secretPut?: (request: SecretRequest) => ToolchainCommand | undefined;

    /** The command that tails live logs, or `undefined` for a target whose logs come from elsewhere. */
    tail?: (request: TailRequest) => ToolchainCommand | undefined;
}

/** Options every driver method receives. */
export interface DriverContext {
    /** Cron expressions codegen discovered, threaded in because they come from the app's code rather than its config. */
    crons?: ReadonlyArray<string>;
    /** Project root containing the `lunora/` directory. */
    projectRoot: string;
}

/**
 * A deploy target's implementation: report what the app needs, and encode it
 * into that host's configuration.
 *
 * **Why `provision` does not take a {@link ResourceGraph}.** The obvious
 * signature is `provision(graph, context)`, and it is wrong. Writing real host
 * configuration needs the host's own encodings — binding names, DO class
 * wiring, migration tags — which the neutral graph deliberately discards. A
 * driver handed only the graph would have to re-derive them, so passing it
 * would be decorative. `infer` is therefore the *reporting* surface (a portable
 * picture of the app's requirements, for logs, diagnostics, and cross-target
 * comparison) and `provision` is the *doing* surface, which owns its own
 * inference end-to-end.
 *
 * That asymmetry is a genuine finding about this seam, not a shortcut: it says
 * the neutral graph is not a sufficient intermediate representation for config
 * emission. If a future target needs one, the graph must grow a host-extension
 * escape hatch rather than pretend it already carries the detail.
 */
export interface DeployDriver {
    /** The target id this driver serves (`"cloudflare"`, …) — matches codegen's `target`. */
    readonly id: string;

    /**
     * Read the app and report what it needs, in provider-neutral terms. Pure
     * with respect to the project: it never writes configuration.
     */
    infer: (context: DriverContext) => Promise<ResourceGraph>;

    /** Human-readable target name, for logs. */
    readonly name: string;

    /**
     * Write the app's requirements into the host's configuration, adding what is
     * missing and leaving existing entries alone. Must be idempotent:
     * provisioning an already-provisioned project reports `changed: false`, and
     * must fold a failed step into a warning rather than throwing.
     */
    provision: (context: DriverContext) => Promise<ProvisionResult>;

    /**
     * Where this driver can execute.
     *
     * `"any"` means the driver is pure — it builds argv and reads files and
     * would run inside a Worker. `"node"` means it needs a real Node process:
     * child processes, a filesystem, native modules.
     *
     * Stated because it is otherwise invisible until it breaks. An
     * IaC-backed driver pulls in a Node-shaped dependency tree — `alchemy@0.93`
     * alone brings `wrangler`, `miniflare`, `esbuild`, `execa`, `glob`,
     * `open`, `proper-lockfile` and `signal-exit` — none of which survive a
     * workerd bundle. A control plane that runs in a Worker must therefore be
     * able to ask *before* importing, and split its work: the pure half
     * (routing, secret writes, teardown calls) in the Worker, convergence in a
     * container. Without this field that split is a comment in a design doc
     * and a bundle error in CI.
     *
     * Defaults to `"node"` when absent — the safe assumption, since a driver
     * that forgot to declare is more likely to be the heavy kind.
     */
    readonly runtime?: "any" | "node";

    /**
     * The host's command-line surface, or `undefined` for a host that has none.
     * Pure: these build argv, they never spawn.
     */
    readonly toolchain?: DriverToolchain;
}

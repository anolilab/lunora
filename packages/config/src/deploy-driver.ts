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
 * **Scope.** This is the inference/provisioning half of §5.3. The `deploy` /
 * `dev` / `tail` / `secret` command surfaces are not modelled yet — those
 * handlers still call wrangler directly, and folding them in is a separate
 * slice.
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
}

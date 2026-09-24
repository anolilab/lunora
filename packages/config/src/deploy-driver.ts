/**
 * `DeployDriver` — the provider-neutral seam between a Lunora command and the
 * host CLI that carries it out (plan 114, §5.3).
 *
 * The seam is the **toolchain surface**: which command a host runs to deploy,
 * serve, tail, or set a secret. A driver only *describes* that command
 * ({@link ToolchainCommand}); it never spawns. The CLI keeps ownership of
 * running it — package-manager resolution (`pnpm exec` / `npx --` / `bun x`)
 * and the injected spawner its tests substitute — so the driver stays free of
 * process concerns and remains trivially testable as a pure function.
 *
 * Each request type below is deliberately neutral: `preview`, `environment`,
 * `temporary` are concepts, not wrangler flags. A second host maps the same
 * request onto its own CLI without the caller changing.
 *
 * Two drivers are registered: Cloudflare (`cloudflare/cloudflare-driver.ts`),
 * which is the only one with a toolchain, and Node (`node/node-driver.ts`),
 * which has none — it is a codegen target, and `lunora deploy` / `lunora dev`
 * refuse it at selection.
 *
 * **What this seam deliberately does NOT carry: configuration inference.** It
 * used to, through an `infer`/`provision` pair over a provider-neutral
 * `ResourceGraph`. Nothing ever called either one — every consumer reads
 * `.toolchain` or just validates the target — and the arm rotted in place: the
 * Node driver was *only* `infer` + `provision`, so its report of what that
 * target cannot serve (containers, undispatched crons) could not reach an
 * operator however wrong the app was. The reason it never got wired is worth
 * keeping: writing real host configuration needs the host's own encodings —
 * binding names, DO class wiring, migration tags — which a neutral graph
 * necessarily discards, so `provision` re-derived them anyway and the graph was
 * decorative. A second target that needs to share inference should grow the
 * seam back with a caller attached, and with an encoding escape hatch.
 */

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
 * The host's command-line surface. Optional as a whole: a host with no vendor
 * CLI (the Node target; a hypothetical API-driven one) declares none, and
 * `isRunnableTarget` refuses it for the commands that would have to shell out.
 */
export interface DriverToolchain {
    /** The command that deploys the app. */
    deploy: (request: DeployRequest) => ToolchainCommand;
    /** The command that runs a local dev server. */
    dev: (request: DevRequest) => ToolchainCommand;
    /** The command that lists remote secret names. */
    secretList: (request: SecretRequest) => ToolchainCommand;
    /** The command that writes one secret. Its value is passed on stdin, never argv. */
    secretPut: (request: SecretRequest) => ToolchainCommand;
    /** The command that tails live logs. */
    tail: (request: TailRequest) => ToolchainCommand;
}

/** A deploy target's implementation: an identity the registry resolves, and the host CLI surface (if any) behind it. */
export interface DeployDriver {
    /** The target id this driver serves (`"cloudflare"`, …) — matches codegen's `target`. */
    readonly id: string;

    /** Human-readable target name, for logs. */
    readonly name: string;

    /**
     * The host's command-line surface, or `undefined` for a host that has none.
     * Pure: these build argv, they never spawn.
     */
    readonly toolchain?: DriverToolchain;
}

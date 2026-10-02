/** The options `lunora deploy` takes and the result it reports — shared by `build`, `prepare` and the package API. */
import type { ApiSpec } from "../../util/api-spec";
import type { DockerProbe } from "../../util/docker";
import type { HealthFetch } from "../../util/health-probe";
import type { Logger } from "../../util/logger";
import type { OutputFormat } from "../../util/output-format";
import type { SpawnDescriptor, Spawner } from "../../util/spawn";
import type { ListRemoteSecretsInputs, ListRemoteSecretsResult } from "../../util/wrangler-secrets";
import type { FetchLike } from "../run/handler";
import type { PreDeployCommand } from "./checks";

interface DeployCommandOptions {
    /** Override the schema-drift gate — deploy even with breaking drift and no new migration. */
    allowSchemaDrift?: boolean;

    /** Which API spec(s) codegen emits. Defaults to codegen's `"openapi"` when omitted. */
    apiSpec?: ApiSpec;

    /**
     * The command the operator actually ran. `build` delegates here with
     * `dryRun: true`; without this the gate names the wrong command in its
     * blocked message and offers flags the real caller does not accept.
     */
    commandName?: PreDeployCommand;
    cwd?: string;
    /** Docker-availability probe injected in tests. Defaults to a real `docker info` check. */
    dockerAvailable?: DockerProbe;

    /**
     * Validate, bundle, and run all pre-deploy gates without publishing
     * (`wrangler deploy --dry-run`). Post-deploy steps (data migrations, schema
     * baseline re-bless) are skipped since nothing shipped.
     */
    dryRun?: boolean;

    /**
     * Write the binding manifest (`build --emit-bindings`) to this path once the
     * bundle exists. Owned here rather than by the caller because it is the last
     * artifact that has to read the PROVISIONED `wrangler.jsonc`, and the dry-run
     * rollback below closes that window as soon as this function returns.
     * Relative paths resolve against the project root.
     */
    emitBindings?: string;
    env?: string;
    /** Fetch implementation injected in tests for `--migrate` RPC calls. */
    fetchImpl?: FetchLike;
    /** Output format: `pretty` (default) or `json`. */
    format?: OutputFormat;

    /**
     * After a successful live deploy, probe the new version's health route
     * (`/_lunora/health/ready`, falling back to `/_lunora/health`) and fail the
     * command when it never answers. Opt-in, not default-on: a worker whose
     * health route is admin-gated or unreachable from CI must still be
     * deployable, and a default network step would turn a successful deploy
     * into a red build for an unrelated reason.
     */
    healthCheck?: boolean;

    /** Injectable fetch for `--health-check`; defaults to the global `fetch`. */
    healthFetch?: HealthFetch;
    /** Injectable inter-attempt delay for `--health-check`; injected in tests to skip the real wait. */
    healthSleep?: (ms: number) => Promise<void>;
    /** Set to `false` to disable interactive spinners (test injection). */
    interactive?: boolean;
    logger: Logger;

    /**
     * When true, after a successful `wrangler deploy`, discover and run all
     * pending data migrations via the worker's `/_lunora/migrate` admin RPC.
     * The worker must be live (exit 0) before migrations are attempted.
     *
     * Implementation note: the status RPC returns the full shard-level
     * migration state, but there is no single authoritative "list of pending
     * migration ids" that can be read client-side before running the worker.
     * Instead, `--migrate` runs `migrate status` followed by `migrate up` for
     * each migration id discovered locally via `discoverMigrations`.  The
     * worker's `MigrationRunner` is idempotent — running `up` on an already-
     * applied migration is a no-op — so this approach is safe.
     */
    migrate?: boolean;

    /** Admin bearer token for `--migrate` (falls back to `LUNORA_ADMIN_TOKEN`). */
    migrateToken?: string;

    /**
     * Worker URL for `--migrate`. REQUIRED when `--migrate` is set — the deploy
     * handler never captures the URL `wrangler deploy` published to, so there is
     * no safe default; omitting it would silently target `http://localhost:8787`
     * (the dev worker), applying the migration to local state instead of prod.
     */
    migrateUrl?: string;

    /**
     * Confirm a production data migration triggered via `--migrate` (the
     * `migrate up --prod` confirmation the standalone command requires). Without
     * it a `--migrate --migrate-url <prod>` deploy refuses to run the migration.
     */
    migrateYes?: boolean;

    /**
     * Emit the bundled worker to this directory via `wrangler deploy --outdir`
     * (paired with `dryRun` by `lunora build`). Also writes esbuild metadata to
     * `<outDir>/bundle-meta.json`. When unset, no artifact is written.
     */
    outDir?: string;

    /**
     * Upload a preview version (`wrangler versions upload`) instead of a live
     * `wrangler deploy`. Codegen + the drift gate + validation still run, but
     * the post-deploy finalize (migrations, baseline re-bless, auto-link, the
     * production summary) is skipped — a preview never shifts live traffic.
     */
    preview?: boolean;
    /** Railpack-availability probe injected in tests. Defaults to a real `railpack --version` + `BUILDKIT_HOST` check. */
    railpackAvailable?: DockerProbe;
    /** Confirm prompt for the missing-secret offer; injected in tests. Defaults to the TTY prompt. */
    secretConfirm?: (message: string) => Promise<boolean>;
    /** Remote-secret lister for the missing-secret offer; injected in tests. Defaults to `wrangler secret list`. */
    secretLister?: (inputs: ListRemoteSecretsInputs) => Promise<ListRemoteSecretsResult>;
    skipCodegen?: boolean;
    /** Deploy only the app, leaving the `lunora.config` services it binds as they are (`--skip-services`). */
    skipServices?: boolean;
    spawner?: Spawner;

    /**
     * Fail the deploy when codegen reports an ERROR-level advisory. Same
     * option `lunora codegen` exposes as `--no-strict-advisories`; defaults to
     * CI detection (on in CI, off locally) so a legitimately-partial target
     * can still be shipped interactively. Does NOT gate platform diagnostics
     * (`platform_unsupported_feature` / `platform_unknown_target`), which
     * always block — those mean the emitted `ctx.*` surface does not match
     * what the target can serve, not merely a style nit.
     */
    strictAdvisories?: boolean;

    /**
     * Deploy target. Falls back to `"target"` in `lunora.config.*`, then
     * `"cloudflare"`, which selects the wrangler
     * toolchain — i.e. today's behavior for every project. An unregistered name
     * throws rather than falling back, so a typo can never ship the app to the
     * wrong provider.
     */
    target?: string;

    /**
     * Deploy to a temporary Cloudflare account (`wrangler deploy --temporary`).
     * For unauthenticated use only: wrangler provisions a short-lived account +
     * token, deploys, and prints a claim URL; the deployment stays live ~60
     * minutes before the unclaimed account is deleted. Wrangler itself errors
     * if credentials are already present (OAuth / `CLOUDFLARE_API_TOKEN` /
     * global API key), so we pass the flag straight through without guarding.
     */
    temporary?: boolean;
    /** Re-bless the committed schema baseline with the current shape (accepts breaking drift). */
    updateSchemaBaseline?: boolean;
}

/**
 * What this run put where — the identity of the thing that was just deployed.
 *
 * Present on every run that reached (and completed) the wrangler invocation,
 * including `--dry-run` and `--preview`, so a consumer can tell "nothing went
 * live" from "went live" without inferring it from a missing `url`. A dry run
 * publishes nothing and therefore never carries a `url`.
 *
 * No `versionId`: the pinned wrangler (see the `wrangler` catalog entry in
 * `pnpm-workspace.yaml`) has no structured deploy output
 * and no flag that returns the version id — it only prints it in prose, and
 * scraping a second value out of prose is exactly what this shouldn't do. The
 * id is available from `lunora deployments list` after the fact.
 */
interface DeployedIdentity {
    /** ISO-8601 stamp taken when the wrangler invocation returned. */
    deployedAt: string;
    /** True when `--dry-run` validated + bundled without publishing. */
    dryRun: boolean;
    /** The Cloudflare environment this run targeted, when `--env` named one. */
    env?: string;
    /** True when `--preview` uploaded a version instead of shifting live traffic. */
    preview: boolean;
    /** The URL wrangler reported publishing to; absent on a dry run, or when the output carried no URL. */
    url?: string;
    /** The Worker name from the project's wrangler config. */
    workerName?: string;
}

/**
 * The `--format json` payload: where the thing went, and every verdict the
 * pre-deploy pipeline reached on the way. `code` and `error` are the envelope's.
 */
interface DeployCommandData {
    deployment?: DeployedIdentity;
    healthCheck?: { error?: string; ok: boolean; url: string };
    mintedSecretsFile?: string;
    schemaDrift?: { blocked: boolean; reason: string };
    validation: {
        problems: ReadonlyArray<string>;
        wranglerPath: string | undefined;
    };
}

interface DeployCommandResult {
    code: number;
    /** What was deployed and where — set once the wrangler invocation completed. */
    deployment?: DeployedIdentity;
    descriptor: SpawnDescriptor | undefined;
    /** Set when the run aborted before reaching the wrangler invocation. */
    error?: string;

    /**
     * The `--health-check` probe's verdict, when the flag was set and the probe
     * ran. A red probe fails the command (`code` is non-zero) — but the deploy
     * itself still succeeded, which is why the reason is reported separately
     * from `error`.
     */
    healthCheck?: { error?: string; ok: boolean; url: string };

    /** Whether the target a successful deploy shipped to has a log tail for `lunora logs`. */
    logsAvailable?: boolean;

    /**
     * The `.dev.vars`-shaped filename (never a full path, never a value) a
     * secret minted during this run was recorded into, when the missing-
     * secret gate minted one — `.dev.vars` for the default environment, or a
     * `.dev.vars.<env>` sibling for an explicit `--env`. `undefined` when
     * nothing was minted this run.
     */
    mintedSecretsFile?: string;
    /** The schema-drift gate verdict, when it ran (skipped on `--skip-codegen`). */
    schemaDrift?: { blocked: boolean; reason: string };
    validation: {
        problems: ReadonlyArray<string>;
        wranglerPath: string | undefined;
    };
}

export type { DeployCommandData, DeployCommandOptions, DeployCommandResult, DeployedIdentity };

/**
 * The control plane's seam to a deploy target (MULTIPLATFORM.md §5.1).
 *
 * Everything the control plane does to a tenant once it exists — converge it,
 * tear it down, find it by hostname, read its request counts, call its admin
 * API, tick its crons — goes through one {@link TargetDriver}. The driver for a
 * project is chosen by the project's `target` column (`src/targets/registry.ts`),
 * never by the request.
 *
 * API-shaped, not CLI-shaped: unlike `@lunora/config`'s `DeployDriver`, nothing
 * here runs a toolchain or reads a checkout. A driver acts on behalf of a tenant
 * with the platform's credentials, from inside the control-plane Worker.
 *
 * Every member names the module it was extracted from, so the history of a
 * Cloudflare assumption is one hop away. The `cloudflare-wfp` implementation
 * lives in `src/targets/cloudflare-wfp/`; the in-memory reference driver the
 * conformance suite is written against lives in `__tests__/support/memory-driver.ts`.
 */
import type { TenantSend } from "../backup/tenant-transport";
import type { BindingSupportTable, BindingType, DeployKind, TenantDeploymentSpec } from "../provision-contract";

/** What converging a release produced. */
export interface ConvergeResult {
    /** SHA-256 of the bundle that is now serving. */
    bundleHash: string;
    /** The tenant's public URL — always {@link TargetDriver.tenantUrl} for the release's alias and kind. */
    url: string;
}

/** A project to tear down (preview TTL cleanup, project deletion): its tenant, then its resources. */
export interface DestroyRef {
    /** The project label — names the tenant and its per-project resources. */
    alias: string;
}

/** What {@link TargetDriver.route} resolves a hostname to. */
export interface TenantRoute {
    /** The deployment's handle on the target (`deployments.resourceRef`; the dispatch script on `cloudflare-wfp`). */
    resourceRef: string;
}

/**
 * The control plane's own routing data, which a driver reads but does not own:
 * custom domains live in the `domains` table and liveness in `deployments`.
 */
export interface RouteLookup {
    /** The resource a verified custom hostname serves, or `null` when it is not one. */
    customDomain: (hostname: string) => Promise<null | string>;
    /** Whether `resourceRef` has a live deployment. */
    live: (resourceRef: string) => Promise<boolean>;
}

/** Requests one resource served in a metering window. */
export interface UsageRow {
    requests: number;
    resourceRef: string;
}

/**
 * Where a target's tenant logs come from.
 *
 * - `tail-consumer` — a platform Worker attached to every tenant
 *   (`src/tail/worker.ts` → `POST /v1/logs/tail`), Cloudflare-only.
 * - `otlp` — the tenant's own `otlpSink` ships to `/v1/{logs,traces,metrics}`
 *   with the org's ingest key, which every target gets regardless.
 */
export type LogSource = { kind: "otlp" } | { kind: "tail-consumer"; service: string };

/** Custom-domain operations (`src/domains/verify.ts`, `router.ts` `handleDomainVerifyRoute`). */
export interface DomainOps {
    /**
     * Request a certificate for a verified hostname. Absent when the target does
     * not issue certificates from the control plane — `cloudflare-wfp` leaves it
     * unset because Cloudflare-for-SaaS issuance has no caller yet (GAPS.md B1).
     */
    issue?: (hostname: string) => Promise<void>;
    /** The CNAME targets a custom hostname must point at to count as routed here (`verifyDomain`'s `platformTargets`). */
    platformTargets: () => string[];
}

/** One tenant deployment as the control plane addresses it. */
export interface TenantHandle {
    /** The deployment's admin bearer, unsealed in-process. Travels only in the `authorization` header. */
    adminToken: string;
    resourceRef: string;
    /** The deployment's public URL (`deployments.url`). */
    url: string;
}

/** What a target can do — the parts the control plane's sweeps branch on. */
export interface TargetCapabilities {
    /**
     * Who fires tenant crons and drains tenant queues.
     *
     * `dispatcher` — the control plane does, over {@link TargetDriver.dispatch},
     * because the target cannot (WfP drops `triggers.crons` for namespaced
     * Workers and a namespaced Worker cannot be a queue consumer;
     * `src/fanout/*`, `server.ts` `scheduled()` / `queue()`). `native` — the
     * target runs them itself and the fan-out skips its deployments.
     */
    fanout: "dispatcher" | "native";

    /**
     * How request counts reach the `platformUsage` ledger. `readback` — the
     * hourly sweep pulls them through {@link TargetDriver.usage}
     * (`sweeps.ts` `usageRollbackPorts`). `pushed` — the target reports them
     * itself and the sweep does not poll.
     */
    metering: "pushed" | "readback";
}

export interface TargetDriver {
    /**
     * How this target satisfies each binding type. The deploy handler validates
     * a manifest against it — refusing, by name, what the target cannot run —
     * before a deployment row exists. A registered target's table is its row of
     * `BINDING_SUPPORT` (`src/provision-contract.ts`).
     */
    readonly bindingSupport: BindingSupportTable;

    /** What the target can actually do. */
    readonly capabilities: TargetCapabilities;

    /**
     * Converge the alias's tenant onto a release (a deploy or a rollback).
     * Idempotent and safe to retry: the same spec twice leaves one tenant on
     * that release. Progress lines go to the driver's log sink.
     * Extracted from `Provisioner.deploy` (formerly `src/provision.ts`).
     */
    deploy: (spec: TenantDeploymentSpec) => Promise<ConvergeResult>;

    /**
     * Tear the alias's tenant and its resources down, data included. Safe to run
     * twice. Extracted from `Provisioner.destroy` (formerly `src/provision.ts`),
     * which the teardown sweep (`src/deploy/teardown.ts`) calls.
     */
    destroy: (reference: DestroyRef) => Promise<void>;

    /**
     * The in-network path to a tenant for the control plane's own fan-out, when
     * {@link TargetCapabilities.fanout} is `dispatcher` — `undefined` when this
     * control-plane deployment has none bound, in which case nothing is fanned
     * out (as before: the cron tick is skipped, a queue batch is retried).
     * From `server.ts` `dispatchCronTick` / `dispatchQueueBatch`.
     */
    dispatch?: (tenant: Pick<TenantHandle, "adminToken" | "resourceRef">) => TenantSend;

    /** Custom-domain verification targets and certificate issuance. */
    domains: DomainOps;

    /** `"cloudflare-wfp"`, `"celld-vps"`, … — the value stored in `projects.target` / `deployments.target`. */
    readonly id: string;

    /** Where tenant logs come from (`src/tail/worker.ts`, `src/telemetry/ingest-key.ts`). */
    logs: LogSource;

    /**
     * Call one tenant's `/_lunora/*` admin surface under its admin bearer:
     * backups and restores. From `tenantSender` (`src/backup/tenant-transport.ts`).
     */
    reach: (tenant: TenantHandle) => TenantSend;

    /**
     * Resolve an inbound hostname to the deployment that serves it, or `null`
     * when nothing live does. From the dispatcher's `resolveTenant`
     * (formerly `src/dispatcher/route.ts`, now `cloudflare-wfp/route.ts`).
     */
    route: (hostname: string, lookup: RouteLookup) => Promise<null | TenantRoute>;

    /**
     * The tenant's public URL. Stable for an alias: the health check, the admin
     * proxy, backups and eject all read the URL recorded from it. From the
     * deploy router's `urlForScript` (`https://${alias}.${appDomain}`).
     */
    tenantUrl: (alias: string, kind: DeployKind) => string;

    /** Why each type {@link bindingSupport} marks `unsupported` is refused, worded for this target. */
    readonly unsupportedReasons: Readonly<Partial<Record<BindingType, string>>>;

    /**
     * Requests per resource with a timestamp strictly after `sinceMs` — the
     * metering readback, when {@link TargetCapabilities.metering} is `readback`
     * and this deployment is configured to read it. From the Analytics Engine
     * reader (formerly `src/metering/analytics.ts`, now `cloudflare-wfp/analytics.ts`).
     */
    usage?: (sinceMs: number) => Promise<UsageRow[]>;
}

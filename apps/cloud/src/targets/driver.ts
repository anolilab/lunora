/**
 * The control plane's seams to a deploy target (MULTIPLATFORM.md §5.1).
 *
 * A target answers in two halves:
 *
 * - {@link TargetDriver} — converging ONE placement: deploy a release onto a
 *   project's tenant, tear it down, and the custom-domain hooks. Built per
 *   placement (`resolveTargetDriver(placement, env)` in
 *   `src/targets/registry.ts`), so a driver always knows where its tenants live
 *   — the cell's dispatch namespace, or the project's box.
 * - {@link TargetFleet} — what the control plane does to ANY tenant of the
 *   target wherever it is placed: reach its admin API, fan crons and queue
 *   batches out to it, read its request counts back. Built per target.
 *
 * What a target IS — where it is placed, who fires its crons, how its usage is
 * metered, which bindings it refuses — is static, and lives in its descriptor
 * (`TARGETS`, `BINDING_SUPPORT`, `UNSUPPORTED_REASONS` in
 * `src/provision-contract.ts`), not here.
 *
 * API-shaped, not CLI-shaped: unlike `@lunora/config`'s `DeployDriver`, nothing
 * here runs a toolchain or reads a checkout. A driver acts on behalf of a tenant
 * with the platform's credentials (or, on `cloudflare-workers`, the connected
 * account's), from inside the control-plane Worker. The implementations live in
 * `src/targets/{cloudflare-wfp,cloudflare-workers,celld-vps}/`; the
 * in-memory reference the conformance suite is written against lives in
 * `__tests__/support/memory-driver.ts`.
 */
import type { TenantSend } from "../backup/tenant-transport";
import type { PeriodUsage } from "../billing/spend";
import type { ControlPlaneStore } from "../d1-store";
import type { EdgeProtection } from "../edge/protection";
import type { TargetId, TenantDeploymentSpec } from "../provision-contract";

/** What one edge-block tick did (`TargetFleet.edgeBlock`). */
export interface EdgeBlockResult {
    blocked: number;
    failed: number;
    unblocked: number;
}

/** One line a target reports while it converges or tears down. */
export type ProgressLine = (line: string) => void;

/** Per-call options of {@link TargetDriver.deploy} and {@link TargetDriver.destroy}. */
export interface ConvergeOptions {
    /** Lines worth showing whoever waits on the converge (`celld-vps`: the box's job progress). */
    onProgress?: ProgressLine;
}

/** What converging a release produced. */
export interface ConvergeResult {
    /** The tenant's public URL — stable for an alias, so the health check, admin proxy, backups and eject all read it. */
    url: string;
}

/**
 * What one resource consumed in a metering window, by meter. A source sets only
 * the meters it reads; an absent or non-positive meter records nothing.
 */
export interface UsageRow {
    meters: PeriodUsage;
    resourceRef: string;
}

/**
 * The independent metering sources of a readback target. Each keeps its own
 * checkpoint per scope, so a failing storage read neither blocks nor skips the
 * request-count window, and the other way round.
 *
 * - `requests` — request counts (`requests`).
 * - `d1` — D1 row reads and writes (`d1RowsRead`, `d1RowsWritten`).
 * - `durableObjects` — Durable Object row reads and writes (`doRowsRead`, `doRowsWritten`).
 * - `workersCpu` — Workers CPU time (`cpuMs`).
 * - `durableObjectRequests` — Durable Object requests (`doRequests`).
 * - `durableObjectDuration` — Durable Object duration (`doDurationGbS`).
 *
 * The compute families are separate from the row families on purpose: each is
 * discovered in the schema on its own, so one that cannot read neither blocks
 * nor skips the meters that can.
 */
export type UsageFamily = "d1" | "durableObjectDuration" | "durableObjectRequests" | "durableObjects" | "requests" | "workersCpu";

/** Every family, in the order a sweep reads them. */
export const USAGE_FAMILIES: ReadonlyArray<UsageFamily> = ["requests", "d1", "durableObjects", "workersCpu", "durableObjectRequests", "durableObjectDuration"];

/**
 * A read window.
 *
 * - `continuous` sources answer what happened in `(sinceMs, untilMs]`.
 * - `hourly` sources answer the hour buckets that START in `[sinceMs, untilMs)`;
 *   both bounds are hour-aligned, and `untilMs` is never an hour that has not
 *   closed yet.
 *
 * Either way, consecutive windows partition time, so nothing is counted twice.
 * A window never spans two calendar months (UTC): the rollback splits it, and
 * bills each part to its own month.
 */
export interface UsageWindow {
    sinceMs: number;
    untilMs: number;
}

/**
 * One metering source.
 *
 * `cadence: "hourly"` marks a dataset that buckets by the hour and lags
 * (Cloudflare's adaptive GraphQL datasets). The rollback then reads only closed
 * hours, so a bucket that is still filling is never read half-full and then
 * skipped.
 *
 * A source that cannot read at all — its dataset is missing, or the token lacks
 * the permission — throws `UsageUnavailableError` (`src/metering/unavailable.ts`)
 * or a `CloudflareTokenError`. The sweep then records the reason where the
 * studio shows it, instead of reporting zero.
 */
export interface UsageSource {
    cadence: "continuous" | "hourly";

    /**
     * What each resource in `scope` consumed in `window`. A row's `resourceRef`
     * must be one only `scope`'s deployments carry, so a source can never
     * attribute usage to a tenant it does not hold.
     */
    read: (scope: string, window: UsageWindow) => Promise<UsageRow[]>;
}

/** One tenant deployment as the control plane addresses it. */
export interface TenantHandle {
    /** The deployment's admin bearer, unsealed in-process. Travels only in the `authorization` header. */
    adminToken: string;
    resourceRef: string;
    /** The deployment's public URL (`deployments.url`). */
    url: string;
}

/** A custom domain as the domain hooks see it. */
export interface CustomDomain {
    /**
     * The certificate this same issuer issued for it earlier (`domains.customHostnameId`),
     * passed only when the row's recorded issuer is this target and scope — a
     * certificate another issuer holds is never this one's to re-read or reuse.
     */
    customHostnameId?: string;
    hostname: string;
}

/** A custom domain's certificate, as the target that issues it reports it (`cloudflare-wfp`: a Cloudflare-for-SaaS custom hostname). */
export interface DomainCertificate {
    /** The issuer's handle on it; absent when none could be requested (`sslStatus: "unconfigured"`). */
    customHostnameId?: string;
    /** Why the certificate is not issued yet, as the issuer says it. */
    error?: string;

    /**
     * Which of the target's issuers holds it ({@link CertificateIssuer.scope};
     * `cloudflare-wfp`: the SaaS zone id). Set with `customHostnameId`, and
     * recorded on the domain row with the issuing target, so the certificate is
     * refreshed and released by that issuer — whatever the project's target is
     * by then.
     */
    scope?: string;
    /** The issuer's certificate status (`initializing`, `pending_validation`, …, `active`), or `unconfigured`. */
    sslStatus: string;
}

/**
 * Custom-domain hooks of one placement (`POST /v1/domains`, `/verify`,
 * `/remove`). Releasing a certificate is NOT here: it goes through the issuer
 * recorded on the domain row ({@link TargetFleet.certificates}), since the
 * project may have moved to another target since it was issued.
 */
export interface DomainOps {
    /**
     * Run after any domain of this placement's project was added, verified or
     * removed, best-effort: a failure is logged, never surfaced. `celld-vps`
     * pushes the box's routing table, which is built from the domain rows, so a
     * verified domain is served — and a removed one dropped — at once rather
     * than at the next push. Absent where serving reads the rows directly.
     */
    domainsChanged?: () => Promise<void>;

    /**
     * Request the certificate of a hostname of this placement's project that
     * just verified, or re-read the one this target issued it earlier
     * (`domain.customHostnameId`). `undefined` where the target issues none —
     * a box terminates its own TLS.
     */
    issue: (domain: CustomDomain) => Promise<DomainCertificate | undefined>;
    /** The CNAME targets a custom hostname must point at to count as routed here (`verifyDomain`'s `platformTargets`). */
    platformTargets: () => string[];
}

/**
 * A target's certificate issuer, fleet-wide: what refreshes and releases a
 * certificate it issued, from the domain row alone — the project may have
 * moved to another target, or be gone.
 */
export interface CertificateIssuer {
    /** Re-read a certificate for the hourly sweep: its status, or `null` once it is gone. */
    refresh: (customHostnameId: string) => Promise<DomainCertificate | null>;
    /** Delete a certificate (and what routes its hostname here). Done when it is already gone. */
    release: (customHostnameId: string) => Promise<void>;
    /** Which issuer this is ({@link DomainCertificate.scope}): it only ever acts on certificates recorded with this scope. */
    scope: string;
}

/** A target's converge surface for one placement. */
export interface TargetDriver {
    /**
     * Converge the alias's tenant onto a release (a deploy or a rollback).
     * Idempotent and safe to retry: the same spec twice leaves one tenant on
     * that release. Extracted from `Provisioner.deploy` (formerly `src/provision.ts`).
     */
    deploy: (spec: TenantDeploymentSpec, options?: ConvergeOptions) => Promise<ConvergeResult>;

    /**
     * Tear the alias's tenant and its resources down, data included. Safe to run
     * twice. Called by the teardown sweep (`src/deploy/teardown.ts`) once the
     * alias has no deployment left.
     */
    destroy: (alias: string, options?: ConvergeOptions) => Promise<void>;
    domains: DomainOps;
    /** The value stored in `projects.target` / `deployments.target`. */
    readonly id: TargetId;
}

/** A target's fleet-wide surface: what the control plane does to any of its tenants, wherever they are placed. */
export interface TargetFleet {
    /**
     * The issuer of the custom-domain certificates this target issues
     * (`DomainOps.issue`). Absent on a target that issues none, or a deployment
     * not configured to.
     */
    certificates?: CertificateIssuer;

    /**
     * The in-network path to a tenant for the control plane's own fan-out, on a
     * target whose descriptor says `fanout: "dispatcher"` — `undefined` when
     * this control-plane deployment has none bound, in which case nothing is
     * fanned out (the cron tick is skipped, a queue batch is retried).
     */
    dispatch?: (tenant: Pick<TenantHandle, "adminToken" | "resourceRef">) => TenantSend;

    /**
     * The platform edge in front of this target's hostnames — firewall events and
     * per-organization edge rules (plan 365 W7). Absent on a target whose traffic
     * the platform's edge does not front (`celld-vps`, `cloudflare-workers`), or
     * on a deployment without the zone and token configured.
     */
    edge?: EdgeProtection;

    /**
     * Stop a suspended organization's traffic before it reaches (and bills) a
     * Worker, and restore it on recovery (plan 365 W8): converge the edge to the
     * suspensions in the store, idempotently. `cloudflare-wfp` only, and only
     * where this deployment holds the SaaS zone or the suspended-hostnames list.
     * Absent elsewhere: a box withholds a suspended organization's routes itself,
     * and a connected account's Worker is the customer's, served without the
     * platform's dispatcher — suspension does not stop it at runtime.
     */
    edgeBlock?: (database: ControlPlaneStore, options: { log: (line: string) => void; now: number }) => Promise<EdgeBlockResult>;

    readonly id: TargetId;

    /**
     * Call one tenant's `/_lunora/*` admin surface under its admin bearer:
     * backups and restores. From `tenantSender` (`src/backup/tenant-transport.ts`).
     */
    reach: (tenant: TenantHandle) => TenantSend;

    /**
     * The metering readback of a `metering: "readback"` target, when this
     * deployment is configured to read it (`cloudflare-wfp/analytics.ts`; on
     * `cloudflare-workers`, each connected account's own analytics, read in
     * `cloudflare-workers/driver.ts`).
     */
    usage?: UsageReadback;
}

/**
 * A readback target's usage, split into SCOPES (one per account it reads) and,
 * within a scope, into {@link UsageFamily | families} (one per dataset). Every
 * (scope, family) pair has its own checkpoint (`usageCheckpoints`, keyed by
 * target and scope key). `cloudflare-wfp` has one scope: this control plane's
 * cell, whose account holds every tenant. `cloudflare-workers` has one per
 * connected Cloudflare account, each read with that account's own token. Two
 * sources sharing one checkpoint would advance one boundary and each skip the
 * other's window.
 */
export interface UsageReadback {
    /** Every scope this deployment reads right now. */
    scopes: () => Promise<string[]>;
    /** The families this deployment reads. Absent ones are not metered here. */
    sources: Partial<Record<UsageFamily, UsageSource>>;
}

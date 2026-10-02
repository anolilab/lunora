/**
 * The control-plane Worker's env, as the Worker entry (`src/server.ts`), its
 * scheduled sweeps (`src/sweeps/scheduled.ts`) and its queue consumer
 * (`src/fanout/platform-queue.ts`) read it.
 */
import type { ShardNamespaceLike } from "@lunora/runtime";

import type { BackupBucket } from "./backup/sweep";
import type { TenantBackupBucket } from "./backup/tenant-transport";
import type { ReleaseBucket } from "./deploy/release-store";
import type { TargetEnvironment } from "./targets/registry";

// Must stay a `type`: an `interface` gets no implicit index signature, so it will
// not satisfy `Record<string, unknown>` at the mailer and alert-delivery call
// sites (`createMailerFromEnv`, `deliverAlert`). Those read keys this type does
// not declare (`RESEND_API_KEY`, `SEND_EMAIL`, …) — it is the set
// this module uses, not the full runtime env, so an undeclared var is not
// necessarily an unused one. The target drivers' keys (`DISPATCHER`, the
// provision box, `LUNORA_CELL`, the Cloudflare credentials) come from
// `TargetEnvironment`.
export type ControlPlaneEnv = TargetEnvironment & {
    /** Secret backing the studio's better-auth sessions. */
    AUTH_SECRET?: string;

    /** Base URL better-auth resolves callbacks against. */
    AUTH_URL?: string;

    /**
     * Private R2 bucket the control-plane dumps are written to (GAPS.md D1).
     * Absent → the backup sweep no-ops. The dump contains every sealed admin
     * token and auth session in the cell, so this bucket must never be public.
     */
    BACKUPS?: BackupBucket;

    /**
     * The control-plane D1's own uuid, which the export REST call addresses.
     * A binding cannot answer its database id, so it is configured; absent →
     * the backup sweep no-ops.
     */
    CONTROL_PLANE_DATABASE_ID?: string;
    /** Creem (MoR) billing secrets (§4). Absent → billing reads work, live calls fail. */
    CREEM_API_KEY?: string;
    CREEM_TEST_MODE?: string;
    CREEM_WEBHOOK_SECRET?: string;
    /** Control-plane D1 — backs the `.global()` cells/organizations tables + auth. */
    DB: unknown;
    /** Optional GitHub OAuth app for studio social sign-in. */
    GITHUB_CLIENT_ID?: string;
    GITHUB_CLIENT_SECRET?: string;
    /** Optional Google OAuth app for studio social sign-in. */
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    /** Bearer token gating the admin endpoints the studio + platform tools call. */
    LUNORA_ADMIN_TOKEN?: string;
    /** Sender address for auth (verification / reset) email; captured in dev. */
    MAIL_FROM?: string;
    /** Private R2 bucket of stored releases (`src/deploy/release-store.ts`); absent → the teardown sweep no-ops. */
    RELEASES?: ReleaseBucket;
    /** 32-byte hex master key that seals admin tokens at rest (§7); absent → dev plaintext fallback. */
    SECRET_ENCRYPTION_KEY?: string;
    SHARD: ShardNamespaceLike;

    /**
     * Private R2 bucket of tenant data snapshots (docs/RESTORE.md). Absent → the
     * tenant backup sweep no-ops and the studio's backup routes answer 500. Holds
     * every project's production data, so it must never be public.
     */
    TENANT_BACKUPS?: TenantBackupBucket;
    /** `"development"` under `lunora dev` (set by vite.config.ts); read by the invite gate's bootstrap carve-out. */
    WORKER_ENV?: string;
};

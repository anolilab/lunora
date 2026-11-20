/**
 * The Cloudflare token permissions, in a module that imports nothing: the studio's
 * Cloudflare accounts tab reads this list in the browser, and the provision contract
 * imports `@lunora/config/celld`, which pulls `node:fs` into any bundle that reaches
 * it. Keep this file dependency-free.
 */

/**
 * The permissions a `cloudflare-workers` account token needs, least-privilege
 * (account-scoped, on the connected account only). Edit on each resource type
 * because the provision box creates the resources; only Workers Scripts is
 * required — the rest are needed once an app binds that type. Zone → Workers
 * Routes: Edit is deliberately absent: it is only needed for custom routes on
 * the customer's zone, which the target does not wire yet. Shared by the
 * connect route's probes (`src/targets/cloudflare-workers/api.ts`) and the
 * studio's instructions, so both name the same list.
 */
export const CLOUDFLARE_TOKEN_PERMISSIONS = {
    analytics: { label: "Account Analytics: Read", required: false, use: "request counts for the Usage tab" },
    billing: { label: "Billing: Read", required: false, use: "the account's real spend on the Cloudflare costs tab (self-serve accounts only)" },
    d1: { label: "D1: Edit", required: false, use: "d1 bindings" },
    kv: { label: "Workers KV Storage: Edit", required: false, use: "kv bindings" },
    notifications: {
        // The connect probe and the alerts overview can only prove the token READS notification
        // policies (Account Settings Read also allows that); a write is proven by the setup itself.
        grantedLabel: "Notifications: read verified",
        label: "Notifications: Edit",
        required: false,
        use: "setting up Cloudflare's own usage alerts on the account from the Cloudflare accounts tab",
    },
    queues: { label: "Queues: Edit", required: false, use: "queue bindings" },
    r2: { label: "Workers R2 Storage: Edit", required: false, use: "r2 bindings" },
    workersScripts: {
        label: "Workers Scripts: Edit",
        required: true,
        use: "uploading the Worker, its cron triggers and queue consumers, and reading the workers.dev subdomain",
    },
} as const satisfies Record<string, { grantedLabel?: string; label: string; required: boolean; use: string }>;

export type CloudflarePermission = keyof typeof CLOUDFLARE_TOKEN_PERMISSIONS;

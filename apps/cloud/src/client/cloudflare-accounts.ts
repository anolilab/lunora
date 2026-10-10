import type { ReturnOf } from "@lunora/client";

import type { api } from "../../lunora/_generated/api.js";
import type { CloudflarePermission } from "../provision-contract";
import { CLOUDFLARE_TOKEN_PERMISSIONS } from "../provision-contract";

/** A connected Cloudflare account as `cloudflareAccounts.list` returns it — never its token. */
export type CloudflareAccountView = ReturnOf<typeof api.cloudflare_accounts.list>[number];

/** Every permission the target uses, in the order the studio lists them: the required one first. */
export const TOKEN_PERMISSIONS: ReadonlyArray<{ id: CloudflarePermission; label: string; required: boolean; use: string }> = (
    Object.keys(CLOUDFLARE_TOKEN_PERMISSIONS) as CloudflarePermission[]
)
    .map((id) => {
        return { id, ...CLOUDFLARE_TOKEN_PERMISSIONS[id] };
    })
    .toSorted((a, b) => Number(b.required) - Number(a.required) || a.label.localeCompare(b.label, "en"));

/**
 * How a permission id the connect route recorded reads on a connection: the
 * token editor's name, or what was actually proven where that is less (see
 * `grantedLabel`), or the id itself for one this build does not know.
 */
export const permissionLabel = (id: string): string => {
    if (!Object.hasOwn(CLOUDFLARE_TOKEN_PERMISSIONS, id)) {
        return id;
    }

    const permission: { grantedLabel?: string; label: string } = CLOUDFLARE_TOKEN_PERMISSIONS[id as CloudflarePermission];

    return permission.grantedLabel ?? permission.label;
};

/** The permissions a connection's token was NOT seen to hold — what an app binding that type would fail on. */
export const missingPermissions = (granted: ReadonlyArray<string>): string[] => {
    const held = new Set(granted);

    return TOKEN_PERMISSIONS.filter((permission) => !held.has(permission.id)).map((permission) => permission.label);
};

/** A connection's display name: its label, then the account's own name. */
export const accountTitle = (account: Pick<CloudflareAccountView, "displayName" | "label">): string =>
    account.displayName !== undefined && account.displayName !== account.label ? `${account.label} (${account.displayName})` : account.label;

const QUOTA_REFUSAL = /\bcloudflareAccounts quota reached\b/u;

/**
 * How a failed connect reads. The plan-limit refusal is reworded to say what to
 * do; anything else is the server's own message, which already names what
 * Cloudflare refused.
 */
export const describeConnectError = (message: string): string =>
    QUOTA_REFUSAL.test(message)
        ? "Your plan's limit of connected Cloudflare accounts is reached. Upgrade the plan, or disconnect an account you no longer use."
        : message;

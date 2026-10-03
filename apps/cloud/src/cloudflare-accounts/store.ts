/**
 * The one reader of `cloudflareAccounts` — the Cloudflare accounts an
 * organization connected (`lunora/cloudflare-accounts.ts`). Every consumer goes
 * through it: the studio's queries and the connect/disconnect mutations, the
 * project placement (`PLACEMENT_HOSTS.account`), the `cloudflare-workers`
 * driver's credentials and its metering scopes.
 *
 * Over a table port, so the same code serves a function's `ctx.db` (its
 * `ctx.db.cloudflareAccounts` facade) and the sweeps' control-plane store
 * ({@link accountTableIn}). The token is unsealed only by {@link unsealAccount},
 * in-process, for one converge or one read — never returned by a query.
 */
import { LunoraError } from "@lunora/server";

import type { CloudflarePermission } from "../provision-contract";
import { decryptSecret } from "../secrets/crypto";

/** A `cloudflareAccounts` row as stored. `.global()` rows answer SQL NULL for an unset column. */
export interface CloudflareAccountRow {
    _id: string;
    /** The Cloudflare account id (32 hex) — the account's own, not this row's. */
    accountId: string;
    /** The cell of the organization that connected it (`organizations.cellId`, which never changes). */
    cellId: string;
    ciphertext: string;
    createdAt: number;
    createdBy: string;
    displayName?: null | string;
    iv: string;
    label: string;
    organizationId: string;
    /** The permission groups the token was seen to hold when last verified. */
    permissions: string[];
    tokenExpiresAt?: null | number;
    updatedAt: number;
    verifiedAt: number;
    workersSubdomain: string;
}

/**
 * The reads the store needs of the table. Method syntax on purpose: a
 * function's `ctx.db.cloudflareAccounts` takes a branded id and a typed
 * `where`, and only a method signature's bivariant parameters let it stand in.
 */
export interface CloudflareAccountTable {
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- bivariant: the typed ctx.db facade must stay assignable
    findMany(options: { where: Record<string, unknown> }): Promise<{ page: ReadonlyArray<unknown> }>;
    // eslint-disable-next-line @typescript-eslint/method-signature-style -- bivariant: the typed ctx.db facade must stay assignable
    get(id: string): Promise<unknown>;
}

/** The table over the control-plane store (`ControlPlaneStore`), pinned to `cloudflareAccounts`. */
export const accountTableIn = (database: {
    findMany: (table: string, options: { where: Record<string, unknown> }) => Promise<{ page: ReadonlyArray<unknown> }>;
    get: (id: string, table?: string) => Promise<unknown>;
}): CloudflareAccountTable => {
    return {
        findMany: async (options) => database.findMany("cloudflareAccounts", options),
        get: async (id) => database.get(id, "cloudflareAccounts"),
    };
};

/** A connected account's token, unsealed. Lives for one converge or one read, in-process. */
export interface AccountAccess {
    accountId: string;
    apiToken: string;
}

/** Unseal `row`'s token with the control plane's master key. */
export const unsealAccount = async (row: Pick<CloudflareAccountRow, "accountId" | "ciphertext" | "iv">, encryptionKey: string): Promise<AccountAccess> => {
    return { accountId: row.accountId, apiToken: await decryptSecret(encryptionKey, { ciphertext: row.ciphertext, iv: row.iv }) };
};

/** Whether the token was seen to hold `permission` when the account was last verified. */
export const holds = (row: Pick<CloudflareAccountRow, "permissions">, permission: CloudflarePermission): boolean => row.permissions.includes(permission);

/** Connection `id` through a by-id read pinned to the table — what a placement lookup has in hand — or `null` once it is gone. */
export const lookupAccount = async (get: (id: string) => Promise<unknown>, id: string): Promise<CloudflareAccountRow | null> =>
    ((await get(id)) as CloudflareAccountRow | null) ?? null;

/** What the store answers over one table. */
export interface CloudflareAccountStore {
    /**
     * Unseal connection `id`'s token.
     * @throws {LunoraError} `CONFLICT` once it is disconnected.
     */
    credentials: (id: string, encryptionKey: string) => Promise<AccountAccess>;
    /** Connection `id`, or `null` once it is disconnected (or erased with its organization). */
    lookup: (id: string) => Promise<CloudflareAccountRow | null>;

    /**
     * The accounts the control plane of `cellId` meters: those connected by
     * organizations placed on that cell (every cell runs the same sweep, and
     * an account read by two would be counted twice), whose token was seen to
     * hold Account Analytics Read — an account without it is never read, so its
     * usage chart stays empty rather than an hourly failure. One indexed read
     * (`by_cell`).
     */
    meteredFor: (cellId: string) => Promise<CloudflareAccountRow[]>;
    /** An organization's connections (`by_org`). */
    ofOrganization: (organizationId: string) => Promise<CloudflareAccountRow[]>;
}

/** The store over one table. */
export const cloudflareAccountStore = (table: CloudflareAccountTable): CloudflareAccountStore => {
    const lookup = async (id: string): Promise<CloudflareAccountRow | null> => lookupAccount(async (row) => table.get(row), id);

    return {
        credentials: async (id: string, encryptionKey: string): Promise<AccountAccess> => {
            const row = await lookup(id);

            if (row === null) {
                throw new LunoraError(
                    "CONFLICT",
                    "this project's Cloudflare account is no longer connected; connect it again and choose it in the project's settings",
                );
            }

            return unsealAccount(row, encryptionKey);
        },
        lookup,
        meteredFor: async (cellId: string): Promise<CloudflareAccountRow[]> => {
            const { page } = await table.findMany({ where: { cellId } });

            return (page as CloudflareAccountRow[]).filter((row) => holds(row, "analytics"));
        },
        ofOrganization: async (organizationId: string): Promise<CloudflareAccountRow[]> => {
            const { page } = await table.findMany({ where: { organizationId } });

            return [...(page as CloudflareAccountRow[])];
        },
    };
};

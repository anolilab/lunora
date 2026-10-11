/**
 * The account cleanup (`account.eraseUser`) against the real control-plane D1
 * in workerd. The node suite drives it over a `ctx` double whose reads never see
 * its own writes; here the deletes and patches land in SQLite and are read back,
 * through the same per-table facades the generated `ctx.db` binds.
 *
 * better-auth's own deletion does not run here (it needs the whole auth plane
 * and its migrations); the handler is what its after-delete hook and the
 * orphaned-membership sweep reach through `POST /v1/account/erase`.
 */
import type { D1CtxDbOptions } from "@lunora/d1";
import { runD1GlobalTableMigrations } from "@lunora/d1";
import { bindTableFacade } from "@lunora/server";
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";

import type { MutationCtx, QueryCtx } from "../../lunora/_generated/server";
import { DELETED_ACTOR, eraseUser, OWNERLESS_ACTION, soleOwnedOrganizations } from "../../lunora/account";
import schema from "../../lunora/schema";
import { buildExec, controlPlaneDatabase } from "../../src/d1-store";

const database = controlPlaneDatabase(env.DB);

/** A function context over the real store, with the facades the generated `ctx.db` binds for these tables. */
const context = (): MutationCtx => {
    const facades = database as unknown as Record<string, ReturnType<typeof bindTableFacade>>;

    for (const table of ["auditLog", "members", "organizations"]) {
        facades[table] = bindTableFacade(database as never, table);
    }

    return { auth: { userId: null }, db: database, now: Date.now() } as unknown as MutationCtx;
};

const rows = async (table: string, where: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const { page } = await database.findMany(table, { where });

    return page as Record<string, unknown>[];
};

describe("account erasure (workerd, real D1)", () => {
    beforeAll(async () => {
        await runD1GlobalTableMigrations(buildExec(env.DB), schema as unknown as D1CtxDbOptions["schema"]);
    });

    it("removes the memberships, replaces the audit actor, and flags an organization left without an owner", async () => {
        const now = Date.now();
        const cellId = (await database.insert("cells", {
            cloudflareAccountId: "acc",
            createdAt: now,
            dispatchNamespacePrefix: "ns",
            name: `cell-${crypto.randomUUID()}`,
            status: "active",
        })) as string;
        const organization = async (name: string): Promise<string> =>
            (await database.insert("organizations", {
                cellId,
                createdAt: now,
                name,
                plan: "free",
                slug: `${name.toLowerCase()}-${crypto.randomUUID()}`,
            })) as string;
        const shared = await organization("Shared");
        const abandoned = await organization("Abandoned");
        const member = (organizationId: string, userId: string, role: string) => database.insert("members", { createdAt: now, organizationId, role, userId });

        // `shared` keeps another owner; `abandoned` lost its other owner between the check and the cleanup.
        await member(shared, "usr_me", "owner");
        await member(shared, "usr_other", "owner");
        await member(abandoned, "usr_me", "owner");
        await member(abandoned, "usr_viewer", "member");
        await database.insert("auditLog", { action: "project.create", actorUserId: "usr_me", createdAt: now, organizationId: shared });
        await database.insert("auditLog", { action: "member.add", actorUserId: "usr_other", createdAt: now, organizationId: shared });

        await expect(soleOwnedOrganizations.handler(context() as unknown as QueryCtx, { userId: "usr_other" })).resolves.toStrictEqual([]);

        const result = await eraseUser.handler(context(), { userId: "usr_me" });

        expect(result).toStrictEqual({ ownerless: [{ id: abandoned, name: "Abandoned" }] });
        await expect(rows("members", { userId: "usr_me" })).resolves.toStrictEqual([]);
        await expect(rows("members", { userId: "usr_other" })).resolves.toHaveLength(1);
        await expect(rows("auditLog", { actorUserId: "usr_me" })).resolves.toStrictEqual([]);

        const sharedLog = await rows("auditLog", { organizationId: shared });

        expect(
            sharedLog.map((entry) => [String(entry["action"]), entry["actorUserId"]]).toSorted((a, b) => String(a[0]).localeCompare(String(b[0]))),
        ).toStrictEqual([
            ["member.add", "usr_other"],
            ["project.create", DELETED_ACTOR],
        ]);
        await expect(rows("auditLog", { action: OWNERLESS_ACTION, organizationId: abandoned })).resolves.toMatchObject([
            { actorUserId: DELETED_ACTOR, target: "account-deletion" },
        ]);

        // Idempotent: a second run (the sweep re-running a finished cleanup) changes nothing and flags nothing new.
        await expect(eraseUser.handler(context(), { userId: "usr_me" })).resolves.toStrictEqual({ ownerless: [] });
    });
});

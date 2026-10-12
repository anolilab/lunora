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
import type { EraseUserResult } from "../../lunora/account";
import { DELETED_ACTOR, eraseUser, OWNERLESS_ACTION, soleOwnedOrganizations } from "../../lunora/account";
import { OPERATOR_ACTOR, operatorPromoteOwner } from "../../lunora/members";
import schema from "../../lunora/schema";
import { authExistingUserIds, ensureAuth } from "../../src/auth";
import { buildExec, controlPlaneDatabase } from "../../src/d1-store";
import type { AccountErasurePorts } from "../../src/sweeps/account-erasure";
import { runAccountErasureSweep } from "../../src/sweeps/account-erasure";

const database = controlPlaneDatabase(env.DB);

/** A function context over the real store, with the facades the generated `ctx.db` binds for these tables. */
const context = (): MutationCtx => {
    const facades = database as unknown as Record<string, ReturnType<typeof bindTableFacade>>;

    // Every table the erasure walks: its own rows, plus the ones a user authored (`AUTHORED_COLUMNS` in lunora/account.ts).
    for (const table of [
        "auditLog",
        "members",
        "organizations",
        "deployments",
        "catalogInstalls",
        "halts",
        "boxEnrolments",
        "cloudflareAccounts",
        "anomalySilences",
        "invitations",
    ]) {
        facades[table] = bindTableFacade(database as never, table);
    }

    return { auth: { userId: null }, db: database, now: Date.now() } as unknown as MutationCtx;
};

const rows = async (table: string, where: Record<string, unknown>): Promise<Record<string, unknown>[]> => {
    const { page } = await database.findMany(table, { where });

    return page as Record<string, unknown>[];
};

/** A seeder of organizations in a fresh cell, created at `now`. */
const organizationSeeder = async (now: number): Promise<(name: string) => Promise<string>> => {
    const cellId = (await database.insert("cells", {
        cloudflareAccountId: "acc",
        createdAt: now,
        dispatchNamespacePrefix: "ns",
        name: `cell-${crypto.randomUUID()}`,
        status: "active",
    })) as string;

    return async (name) =>
        (await database.insert("organizations", {
            cellId,
            createdAt: now,
            name,
            plan: "free",
            slug: `${name.toLowerCase()}-${crypto.randomUUID()}`,
        })) as string;
};

describe("account erasure (workerd, real D1)", () => {
    beforeAll(async () => {
        await runD1GlobalTableMigrations(buildExec(env.DB), schema as unknown as D1CtxDbOptions["schema"]);
    });

    it("removes the memberships, replaces the audit actor, and flags an organization left without an owner", async () => {
        const now = Date.now();
        const organization = await organizationSeeder(now);
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

    it("refuses an operator removal of a sole owner with nothing written, and the sweep leaves them alone until another member is promoted", async () => {
        const now = Date.now();
        const organization = await organizationSeeder(now);
        const solo = await organization("Solo");
        const team = await organization("Team");
        const member = (organizationId: string, userId: string, role: string) => database.insert("members", { createdAt: now, organizationId, role, userId });

        await member(solo, "usr_op", "owner");
        const peer = (await member(solo, "usr_op_peer", "member")) as string;

        await member(team, "usr_op", "member");
        await member(team, "usr_op_lead", "owner");
        await database.insert("auditLog", { action: "project.create", actorUserId: "usr_op", createdAt: now, organizationId: solo });
        await database.insert("auditLog", {
            action: "member.set-role",
            actorUserId: "usr_op_lead",
            createdAt: now,
            organizationId: team,
            target: "usr_op → member",
        });

        await expect(eraseUser.handler(context(), { operator: true, userId: "usr_op" })).resolves.toStrictEqual({
            ownerless: [],
            refused: [{ id: solo, name: "Solo" }],
        });

        // Nothing was written: every membership, the audit actor and the old-format target still name usr_op.
        await expect(rows("members", { userId: "usr_op" })).resolves.toHaveLength(2);
        await expect(rows("auditLog", { actorUserId: "usr_op" })).resolves.toHaveLength(1);
        await expect(rows("auditLog", { action: "member.set-role", organizationId: team })).resolves.toMatchObject([{ target: "usr_op → member" }]);

        // The auth layer no longer has usr_op: the sweep hands them to the erasure, which refuses and writes nothing.
        const calls: string[] = [];
        const sweepPorts: AccountErasurePorts = {
            erase: async (userId) => {
                calls.push(userId);

                const result: EraseUserResult = await eraseUser.handler(context(), { operator: true, userId });

                return result.refused ? { refused: result.refused.map((entry) => entry.id) } : true;
            },
            existingUserIds: (userIds) => Promise.resolve(new Set(userIds.filter((userId) => userId !== "usr_op"))),
        };

        await expect(runAccountErasureSweep(database, sweepPorts)).resolves.toMatchObject({ leftForOperator: [{ organizationIds: [solo], userId: "usr_op" }] });
        expect(calls).toStrictEqual(["usr_op"]);
        await expect(rows("members", { userId: "usr_op" })).resolves.toHaveLength(2);
        await expect(rows("auditLog", { actorUserId: "usr_op" })).resolves.toHaveLength(1);

        // The operator promotes the peer; the next sweep erases usr_op like any other orphan.
        await expect(operatorPromoteOwner.handler(context(), { organizationId: solo as never, userId: "usr_op_peer" })).resolves.toStrictEqual({
            memberId: peer,
            promoted: true,
        });
        await expect(rows("auditLog", { action: "member.set-role", organizationId: solo })).resolves.toMatchObject([
            { actorUserId: OPERATOR_ACTOR, target: `${peer} → owner` },
        ]);

        await expect(runAccountErasureSweep(database, sweepPorts)).resolves.toMatchObject({ erased: ["usr_op"], leftForOperator: [] });

        expect(calls).toStrictEqual(["usr_op", "usr_op"]);
        await expect(rows("members", { userId: "usr_op" })).resolves.toStrictEqual([]);
        await expect(rows("members", { organizationId: solo })).resolves.toMatchObject([{ role: "owner", userId: "usr_op_peer" }]);
        await expect(rows("auditLog", { actorUserId: "usr_op" })).resolves.toStrictEqual([]);
        await expect(rows("auditLog", { action: "member.set-role", organizationId: team })).resolves.toMatchObject([{ target: `${DELETED_ACTOR} → member` }]);
        await expect(rows("auditLog", { action: OWNERLESS_ACTION, organizationId: solo })).resolves.toStrictEqual([]);
    });

    it("refuses to promote a user who is not a member, and writes nothing", async () => {
        const organization = await organizationSeeder(Date.now());
        const lone = await organization("Lone");

        await expect(operatorPromoteOwner.handler(context(), { organizationId: lone as never, userId: "usr_stranger" })).rejects.toThrow(
            "not a member of this organization",
        );
        await expect(rows("members", { organizationId: lone })).resolves.toStrictEqual([]);
        await expect(rows("auditLog", { organizationId: lone })).resolves.toStrictEqual([]);
    });
});

/**
 * The sweep erases every member this lookup leaves out, so it is checked against
 * the real auth plane over the real D1: an `in` lookup that silently matched
 * nothing would read every user as deleted.
 */
describe("auth user lookup for the orphaned-membership sweep (workerd, real D1)", () => {
    it("answers exactly the ids that still have a user row", async () => {
        const authEnv = { AUTH_SECRET: "s".repeat(32), DB: env.DB, LUNORA_ORIGIN_URL: "https://cloud.test" };
        const instance = await ensureAuth(authEnv, "https://cloud.test");
        const { adapter } = await instance.$context;
        const now = new Date();
        const ids = Array.from({ length: 105 }, (_, index) => `usr_live_${String(index)}`);

        for (const id of ids) {
            // eslint-disable-next-line no-await-in-loop -- seeding, one row at a time
            await adapter.create({
                data: { createdAt: now, email: `${id}@example.test`, emailVerified: true, id, name: id, updatedAt: now },
                forceAllowId: true,
                model: "user",
            });
        }

        // More ids than one `in` chunk, or one D1 statement, holds: the chunking is exercised too.
        const existing = await authExistingUserIds(authEnv)([...ids, "usr_missing"]);

        expect([...existing].toSorted((a, b) => a.localeCompare(b))).toStrictEqual(ids.toSorted((a, b) => a.localeCompare(b)));
    });
});

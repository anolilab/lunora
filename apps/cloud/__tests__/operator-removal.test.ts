import type { AuthAdmin } from "@lunora/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/internal";
import { DELETED_ACTOR, eraseUser, ERASURE_ACTOR, OWNER_REMOVED_ACTION, OWNERLESS_ACTION, soleOwnedOrganizations } from "../lunora/account";
import { list as listAuditLog } from "../lunora/audit-log";
import { setRole } from "../lunora/members";
import { handleAccountEraseRoute } from "../src/deploy/routes/account";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { withControlPlaneErasure } from "../src/operator-removal";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * An operator removing a user through the auth admin plane erases what the
 * control plane holds about them, as a self-service deletion does, and is never
 * refused for a sole owner: that membership is kept, so the organization keeps
 * an owner, and marked for support to transfer.
 * And the audit log's `member.set-role` entries name the membership, not the
 * user, so an erasure leaves no user id behind in them.
 */

const workerFetch = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());

// eslint-disable-next-line vitest/prefer-import-in-mock -- the worker stub is partial
vi.mock("../src/control-plane-worker", () => {
    return {
        controlPlaneWorker: () => {
            return { fetch: workerFetch };
        },
    };
});

const member = (id: string, organizationId: string, userId: string, role = "owner") => {
    return { _id: id, createdAt: 1, organizationId, role, userId };
};

type Ops = ReturnType<typeof makeCtx>["ops"];

const deletes = (ops: Ops): string[] => ops.flatMap((op) => (op.kind === "delete" ? [op.id] : []));
const patches = (ops: Ops) => ops.flatMap((op) => (op.kind === "patch" ? [{ id: op.id, patch: op.patch }] : []));
const auditInserts = (ops: Ops) => ops.flatMap((op) => (op.kind === "insert" && op.table === "auditLog" ? [op.document] : []));

/** Every table the operator erasure reads or writes. */
const operatorTables = () => {
    return {
        auditLog: [
            { _id: "a1", action: "project.create", actorUserId: "usr_me", createdAt: 1, organizationId: "org_1" },
            { _id: "a2", action: "member.add", actorUserId: "usr_other", createdAt: 2, organizationId: "org_2" },
            { _id: "a3", action: "project.delete", actorUserId: "usr_me", createdAt: 3, organizationId: "org_2" },
        ],
        members: [
            member("m1", "org_1", "usr_me"),
            member("m2", "org_1", "usr_other", "admin"),
            member("m3", "org_2", "usr_me", "member"),
            member("m4", "org_2", "usr_other"),
        ],
        organizations: [
            { _id: "org_1", name: "Acme" },
            { _id: "org_2", name: "Globex" },
        ],
    };
};

describe("operator erasure", () => {
    it("erases the other memberships and anonymises the audit actor, without refusing a sole owner", async () => {
        const { ctx, ops } = makeCtx(operatorTables());

        const result = await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(result).toStrictEqual({ ownerless: [], retainedOwnerOf: [{ id: "org_1", name: "Acme" }] });
        expect(deletes(ops)).toStrictEqual(["m3"]);
        expect(patches(ops)).toStrictEqual([
            { id: "a1", patch: { actorUserId: DELETED_ACTOR } },
            { id: "a3", patch: { actorUserId: DELETED_ACTOR } },
        ]);
    });

    it("keeps a sole owner's membership, marks it for support, and changes nothing else", async () => {
        const { ctx, ops } = makeCtx(operatorTables());

        await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        const marks = auditInserts(ops);

        expect(marks).toHaveLength(1);
        expect(marks[0]).toMatchObject({ action: OWNER_REMOVED_ACTION, actorUserId: ERASURE_ACTOR, organizationId: "org_1" });
        expect(JSON.stringify(marks)).not.toContain("usr_me");
        // The owner membership, the organization row and its other members are untouched.
        expect(deletes(ops)).not.toContain("m1");
        expect(deletes(ops)).not.toContain("org_1");
        expect(deletes(ops)).not.toContain("m2");
        expect(ops.some((op) => op.kind === "patch" && op.id === "org_1")).toBe(false);
    });

    it("does not mark a kept membership twice when the removal runs again", async () => {
        const first = makeCtx(operatorTables());

        await eraseUser.handler(first.ctx, { operator: true, userId: "usr_me" });

        const [mark] = auditInserts(first.ops);
        const tables = operatorTables();
        const { ctx, ops } = makeCtx({ ...tables, auditLog: [...tables.auditLog, { _id: "a_mark", ...mark }] });

        await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(auditInserts(ops)).toStrictEqual([]);
    });

    it("still refuses a self-service deletion by a sole owner", async () => {
        // Self-service refuses in the before-delete check, which writes nothing; eraseUser runs after it.
        const { ctx, ops } = makeCtx(operatorTables());

        await expect(soleOwnedOrganizations.handler(ctx, { userId: "usr_me" })).resolves.toStrictEqual([{ id: "org_1", name: "Acme" }]);
        expect(ops).toStrictEqual([]);
    });

    it("does not also flag a kept organization as ownerless", async () => {
        const { ctx, ops } = makeCtx(operatorTables());

        await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(auditInserts(ops).map((entry) => entry["action"])).toStrictEqual([OWNER_REMOVED_ACTION]);
    });

    it("still flags a co-owned organization whose other owner left at the same moment", async () => {
        // org_1 is solely owned and kept; org_2 has a co-owner at the first read, who leaves before the re-read.
        const tables = {
            auditLog: [],
            members: [
                member("m1", "org_1", "usr_me"),
                member("m3", "org_2", "usr_me"),
                member("m4", "org_2", "usr_co"),
                member("m5", "org_2", "usr_viewer", "member"),
            ],
            organizations: [
                { _id: "org_1", name: "Acme" },
                { _id: "org_2", name: "Globex" },
            ],
        };
        const { ctx, ops } = makeCtx(tables, { now: 42 });
        const { members } = ctx.db as unknown as { members: { findMany: (args: { where: Record<string, unknown> }) => Promise<unknown> } };
        const read = members.findMany;

        members.findMany = async (args) => {
            const answer = await read(args);

            if (args.where["organizationId"] === "org_2" && args.where["role"] === "owner") {
                tables.members = tables.members.filter((row) => row._id !== "m4");
            }

            return answer;
        };

        const result = await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(result).toStrictEqual({ ownerless: [{ id: "org_2", name: "Globex" }], retainedOwnerOf: [{ id: "org_1", name: "Acme" }] });
        expect(deletes(ops)).toStrictEqual(["m3"]);
        expect(auditInserts(ops)).toMatchObject([
            { action: OWNER_REMOVED_ACTION, organizationId: "org_1" },
            { action: OWNERLESS_ACTION, createdAt: 42, organizationId: "org_2" },
        ]);
    });
});

describe("operator erasure route", () => {
    it("passes the operator flag to the mutation and answers with the kept owner memberships", async () => {
        const runMutation = vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(async () => {
            return { ownerless: [], retainedOwnerOf: [{ id: "org_1", name: "Acme" }] };
        });
        const environment = {
            __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery: vi.fn<() => Promise<unknown>>() },
        } as unknown as RouterEnv;

        const response = await handleAccountEraseRoute(
            new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify({ operator: true, userId: "usr_me" }), method: "POST" }),
            environment,
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ erased: true, ownerless: [], retainedOwnerOf: [{ id: "org_1", name: "Acme" }] });
        expect(runMutation).toHaveBeenCalledWith(internal.account.eraseUser, { operator: true, userId: "usr_me" });
    });

    it("refuses an operator flag that is not a boolean, and an operator check", async () => {
        const runMutation = vi.fn<() => Promise<unknown>>();
        const runQuery = vi.fn<() => Promise<unknown>>();
        const environment = { __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery } } as unknown as RouterEnv;
        const post = (body: unknown) =>
            handleAccountEraseRoute(new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify(body), method: "POST" }), environment);

        const notBoolean = await post({ operator: "yes", userId: "usr_me" });
        const operatorCheck = await post({ check: true, operator: true, userId: "usr_me" });

        expect(notBoolean.status).toBe(400);
        expect(operatorCheck.status).toBe(400);
        expect(runMutation).not.toHaveBeenCalled();
        expect(runQuery).not.toHaveBeenCalled();
    });

    it("erases a self-service deletion without the operator flag", async () => {
        const runMutation = vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(async () => {
            return { ownerless: [] };
        });
        const environment = {
            __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery: vi.fn<() => Promise<unknown>>() },
        } as unknown as RouterEnv;

        const response = await handleAccountEraseRoute(
            new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify({ userId: "usr_me" }), method: "POST" }),
            environment,
        );

        await expect(response.json()).resolves.toStrictEqual({ erased: true, ownerless: [] });
        expect(runMutation).toHaveBeenCalledWith(internal.account.eraseUser, { userId: "usr_me" });
    });
});

describe("operator removeUser", () => {
    const calls: string[] = [];
    const adminDouble = (): AuthAdmin =>
        ({
            removeUser: async ({ userId }: { userId: string }) => {
                calls.push(`auth:${userId}`);
            },
        }) as unknown as AuthAdmin;

    beforeEach(() => {
        calls.length = 0;
        workerFetch.mockReset();
    });

    it("erases the control plane's data before the auth cascade", async () => {
        workerFetch.mockImplementation(async (request) => {
            calls.push(`erase:${await request.text()}`);

            return Response.json({ erased: true, retainedOwnerOf: [] });
        });

        await withControlPlaneErasure(adminDouble(), { DB: {}, LUNORA_ADMIN_TOKEN: "admin" }).removeUser({ userId: "usr_me" });

        expect(calls).toStrictEqual([`erase:${JSON.stringify({ operator: true, userId: "usr_me" })}`, "auth:usr_me"]);
        expect(workerFetch.mock.calls[0]?.[0].headers.get("authorization")).toBe("Bearer admin");
    });

    it("does not remove the user when the erasure fails", async () => {
        workerFetch.mockResolvedValue(Response.json({ error: "boom" }, { status: 500 }));

        await expect(withControlPlaneErasure(adminDouble(), { DB: {}, LUNORA_ADMIN_TOKEN: "admin" }).removeUser({ userId: "usr_me" })).rejects.toThrow(
            "the user was not removed",
        );
        expect(calls).toStrictEqual([]);
    });

    it("does not remove the user when no admin token is configured", async () => {
        await expect(withControlPlaneErasure(adminDouble(), { DB: {} }).removeUser({ userId: "usr_me" })).rejects.toThrow("no admin token configured");
        expect(workerFetch).not.toHaveBeenCalled();
        expect(calls).toStrictEqual([]);
    });
});

describe("member.set-role audit target", () => {
    it("names the membership row, not the user", async () => {
        const { ctx, ops } = makeCtx({
            auditLog: [],
            members: [owner("org_1"), member("m_target", "org_1", "usr_target", "member")],
        });

        await setRole.handler(ctx, { id: "m_target" as never, organizationId: "org_1" as never, role: "admin" });

        const [entry] = auditInserts(ops);

        expect(entry).toMatchObject({ action: "member.set-role", target: "m_target → admin" });
        expect(String(entry?.["target"])).not.toContain("usr_target");
    });

    it("still reads an entry written in the old user-id format", async () => {
        const legacy = { _id: "a_old", action: "member.set-role", actorUserId: "usr_1", createdAt: 5, organizationId: "org_1", target: "usr_target → admin" };
        const { ctx } = makeCtx({ auditLog: [legacy], members: [owner("org_1")] });

        await expect(listAuditLog.handler(ctx, { organizationId: "org_1" as never })).resolves.toStrictEqual([legacy]);
    });

    it("takes the erased user's id out of old-format entries", async () => {
        const { ctx, ops } = makeCtx({
            auditLog: [
                { _id: "a_old", action: "member.set-role", actorUserId: "usr_other", createdAt: 5, organizationId: "org_2", target: "usr_me → admin" },
                { _id: "a_new", action: "member.set-role", actorUserId: "usr_other", createdAt: 6, organizationId: "org_2", target: "m3 → member" },
                { _id: "a_peer", action: "member.set-role", actorUserId: "usr_other", createdAt: 7, organizationId: "org_2", target: "usr_meta → viewer" },
            ],
            members: [member("m3", "org_2", "usr_me", "member"), member("m4", "org_2", "usr_other")],
            organizations: [{ _id: "org_2", name: "Globex" }],
        });

        await eraseUser.handler(ctx, { userId: "usr_me" });

        expect(patches(ops)).toStrictEqual([{ id: "a_old", patch: { target: `${DELETED_ACTOR} → admin` } }]);
    });
});

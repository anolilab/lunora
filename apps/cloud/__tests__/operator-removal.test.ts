import type { AuthAdmin } from "@lunora/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/internal";
import { DELETED_ACTOR, eraseUser, OWNERLESS_ACTION, soleOwnedOrganizations } from "../lunora/account";
import { list as listAuditLog } from "../lunora/audit-log";
import { OPERATOR_ACTOR, operatorPromoteOwner, setRole } from "../lunora/members";
import { handleAccountEraseRoute, handleOwnerPromoteRoute } from "../src/deploy/routes/account";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { withControlPlaneErasure } from "../src/operator-removal";
import { makeCtx, owner } from "./_helpers/fake-ctx";

/**
 * An operator removing a user through the auth admin plane erases what the
 * control plane holds about them, as a self-service deletion does, and is
 * refused, with nothing written, while the user is an organization's only owner.
 * The operator then promotes another member to owner and removes the user again.
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
    it("refuses a sole owner and writes nothing", async () => {
        const { ctx, ops } = makeCtx(operatorTables());

        const result = await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(result).toStrictEqual({ ownerless: [], refused: [{ id: "org_1", name: "Acme" }] });
        expect(ops).toStrictEqual([]);
    });

    it("erases every membership and anonymises the audit actor once the organization has another owner", async () => {
        const tables = operatorTables();
        const { ctx, ops } = makeCtx({ ...tables, members: [...tables.members, member("m5", "org_1", "usr_co")] });

        const result = await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(result).toStrictEqual({ ownerless: [] });
        expect(deletes(ops).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);
        expect(patches(ops)).toStrictEqual([
            { id: "a1", patch: { actorUserId: DELETED_ACTOR } },
            { id: "a3", patch: { actorUserId: DELETED_ACTOR } },
        ]);
        expect(auditInserts(ops)).toStrictEqual([]);
    });

    it("does not refuse over an organization already scheduled for deletion", async () => {
        const tables = operatorTables();
        const { ctx, ops } = makeCtx({
            ...tables,
            organizations: [
                { _id: "org_1", deletionRequestedAt: 5, name: "Acme" },
                { _id: "org_2", name: "Globex" },
            ],
        });

        await expect(eraseUser.handler(ctx, { operator: true, userId: "usr_me" })).resolves.toStrictEqual({ ownerless: [] });
        expect(deletes(ops).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);
    });

    it("does not refuse over an organization whose row is gone", async () => {
        const tables = operatorTables();
        const { ctx, ops } = makeCtx({ ...tables, organizations: [{ _id: "org_2", name: "Globex" }] });

        await expect(eraseUser.handler(ctx, { operator: true, userId: "usr_me" })).resolves.toStrictEqual({ ownerless: [] });
        expect(deletes(ops).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);
    });

    it("still refuses a self-service deletion by a sole owner", async () => {
        // Self-service refuses in the before-delete check, which writes nothing; eraseUser runs after it.
        const { ctx, ops } = makeCtx(operatorTables());

        await expect(soleOwnedOrganizations.handler(ctx, { userId: "usr_me" })).resolves.toStrictEqual([{ id: "org_1", name: "Acme" }]);
        expect(ops).toStrictEqual([]);
    });

    it("still flags a co-owned organization whose other owner left at the same moment", async () => {
        // org_2 has a co-owner at the operator check, who leaves before the re-read after the writes.
        const tables = {
            auditLog: [],
            members: [member("m3", "org_2", "usr_me"), member("m4", "org_2", "usr_co"), member("m5", "org_2", "usr_viewer", "member")],
            organizations: [{ _id: "org_2", name: "Globex" }],
        };
        const { ctx, ops } = makeCtx(tables, { now: 42 });
        const { members } = ctx.db as unknown as { members: { findMany: (args: { where: Record<string, unknown> }) => Promise<unknown> } };
        const read = members.findMany;
        let ownerReads = 0;

        members.findMany = async (args) => {
            const answer = await read(args);

            // The owner reads are: the operator check, the ownerless check before the
            // writes, and the re-read after them. The co-owner leaves after the second.
            if (args.where["organizationId"] === "org_2" && args.where["role"] === "owner") {
                ownerReads += 1;

                if (ownerReads === 2) {
                    tables.members = tables.members.filter((row) => row._id !== "m4");
                }
            }

            return answer;
        };

        const result = await eraseUser.handler(ctx, { operator: true, userId: "usr_me" });

        expect(ownerReads).toBe(3);
        expect(result).toStrictEqual({ ownerless: [{ id: "org_2", name: "Globex" }] });
        expect(deletes(ops)).toStrictEqual(["m3"]);
        expect(auditInserts(ops)).toMatchObject([{ action: OWNERLESS_ACTION, createdAt: 42, organizationId: "org_2" }]);
    });
});

describe("operator erasure route", () => {
    const environmentWith = (runMutation: (reference: unknown, args: unknown) => Promise<unknown>): RouterEnv =>
        ({
            __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery: vi.fn<() => Promise<unknown>>() },
        }) as unknown as RouterEnv;

    it("passes the operator flag to the mutation and answers a refusal with 409 naming the organizations", async () => {
        const runMutation = vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(async () => {
            return { ownerless: [], refused: [{ id: "org_1", name: "Acme" }] };
        });

        const response = await handleAccountEraseRoute(
            new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify({ operator: true, userId: "usr_me" }), method: "POST" }),
            environmentWith(runMutation),
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toStrictEqual({
            error: expect.stringContaining('only owner of "Acme"'),
            organizations: [{ id: "org_1", name: "Acme" }],
        });
        expect(runMutation).toHaveBeenCalledWith(internal.account.eraseUser, { operator: true, userId: "usr_me" });
    });

    it("answers an operator erasure that went through like a self-service one", async () => {
        const response = await handleAccountEraseRoute(
            new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify({ operator: true, userId: "usr_me" }), method: "POST" }),
            environmentWith(async () => {
                return { ownerless: [] };
            }),
        );

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ erased: true, ownerless: [] });
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

        const response = await handleAccountEraseRoute(
            new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify({ userId: "usr_me" }), method: "POST" }),
            environmentWith(runMutation),
        );

        await expect(response.json()).resolves.toStrictEqual({ erased: true, ownerless: [] });
        expect(runMutation).toHaveBeenCalledWith(internal.account.eraseUser, { userId: "usr_me" });
    });
});

describe("operator owner promotion", () => {
    const promoteTables = () => {
        return {
            auditLog: [],
            members: [member("m1", "org_1", "usr_me"), member("m2", "org_1", "usr_peer", "admin"), member("m9", "org_2", "usr_outsider", "member")],
            organizations: [
                { _id: "org_1", name: "Acme" },
                { _id: "org_2", name: "Globex" },
            ],
        };
    };

    it("makes the member an owner and audits it as the operator, naming the membership", async () => {
        const { ctx, ops } = makeCtx(promoteTables(), { now: 7 });

        await expect(operatorPromoteOwner.handler(ctx, { organizationId: "org_1" as never, userId: "usr_peer" })).resolves.toStrictEqual({
            memberId: "m2",
            promoted: true,
        });
        expect(patches(ops)).toStrictEqual([{ id: "m2", patch: { role: "owner" } }]);
        expect(auditInserts(ops)).toStrictEqual([
            { action: "member.set-role", actorUserId: OPERATOR_ACTOR, createdAt: 7, organizationId: "org_1", target: "m2 → owner" },
        ]);
        expect(OPERATOR_ACTOR).toBe("system:operator");
        expect(deletes(ops)).toStrictEqual([]);
    });

    it("refuses a user who is not a member of the organization, and writes nothing", async () => {
        const { ctx, ops } = makeCtx(promoteTables());

        await expect(operatorPromoteOwner.handler(ctx, { organizationId: "org_1" as never, userId: "usr_outsider" })).rejects.toThrow(
            "not a member of this organization",
        );
        expect(ops).toStrictEqual([]);
    });

    it("refuses an organization that does not exist", async () => {
        const { ctx, ops } = makeCtx(promoteTables());

        await expect(operatorPromoteOwner.handler(ctx, { organizationId: "org_none" as never, userId: "usr_peer" })).rejects.toThrow("organization not found");
        expect(ops).toStrictEqual([]);
    });

    it("leaves an existing owner as they are and writes nothing", async () => {
        const { ctx, ops } = makeCtx(promoteTables());

        await expect(operatorPromoteOwner.handler(ctx, { organizationId: "org_1" as never, userId: "usr_me" })).resolves.toStrictEqual({
            memberId: "m1",
            promoted: false,
        });
        expect(ops).toStrictEqual([]);
    });

    it("lets the refused removal go through once another member is an owner", async () => {
        const tables = operatorTables();
        const promotion = makeCtx(tables);

        await operatorPromoteOwner.handler(promotion.ctx, { organizationId: "org_1" as never, userId: "usr_other" });

        const promoted = tables.members.map((row) => (row._id === "m2" ? { ...row, role: "owner" } : row));
        const { ctx, ops } = makeCtx({ ...tables, members: promoted });

        await expect(eraseUser.handler(ctx, { operator: true, userId: "usr_me" })).resolves.toStrictEqual({ ownerless: [] });
        expect(deletes(ops).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);
    });
});

describe("operator owner promotion route", () => {
    const post = (body: unknown, runMutation: (reference: unknown, args: unknown) => Promise<unknown>) =>
        handleOwnerPromoteRoute(new Request("https://cloud.test/v1/organizations/owners", { body: JSON.stringify(body), method: "POST" }), {
            __lunoraCtx: { runAction: vi.fn<() => Promise<unknown>>(), runMutation, runQuery: vi.fn<() => Promise<unknown>>() },
        } as unknown as RouterEnv);

    it("runs the promotion with the organization and user", async () => {
        const runMutation = vi.fn<(reference: unknown, args: unknown) => Promise<unknown>>(async () => {
            return { memberId: "m2", promoted: true };
        });

        const response = await post({ organizationId: "org_1", userId: "usr_peer" }, runMutation);

        expect(response.status).toBe(200);
        await expect(response.json()).resolves.toStrictEqual({ memberId: "m2", ok: true, promoted: true });
        expect(runMutation).toHaveBeenCalledWith(internal.members.operatorPromoteOwner, { organizationId: "org_1", userId: "usr_peer" });
    });

    it("answers 404 when the user is not a member", async () => {
        const { ctx } = makeCtx({ auditLog: [], members: [], organizations: [{ _id: "org_1", name: "Acme" }] });
        const response = await post({ organizationId: "org_1", userId: "usr_outsider" }, async (_reference, args) =>
            operatorPromoteOwner.handler(ctx, args as { organizationId: never; userId: string }),
        );

        expect(response.status).toBe(404);
    });

    it("refuses a body without both ids", async () => {
        const runMutation = vi.fn<() => Promise<unknown>>();

        await expect(post({ organizationId: "org_1" }, runMutation)).resolves.toHaveProperty("status", 400);
        await expect(post({ userId: "usr_peer" }, runMutation)).resolves.toHaveProperty("status", 400);
        expect(runMutation).not.toHaveBeenCalled();
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

    it("checks, removes the user, then cleans up the control plane's data", async () => {
        workerFetch.mockImplementation(async (request) => {
            calls.push(`${request.url.endsWith("/v1/account/erase") ? "erase" : "other"}:${await request.text()}`);

            return Response.json({ erasable: true, ownerless: [] });
        });

        await withControlPlaneErasure(adminDouble(), { DB: {}, LUNORA_ADMIN_TOKEN: "admin" }).removeUser({ userId: "usr_me" });

        expect(calls).toStrictEqual([
            `erase:${JSON.stringify({ check: true, userId: "usr_me" })}`,
            "auth:usr_me",
            `erase:${JSON.stringify({ userId: "usr_me" })}`,
        ]);
        expect(workerFetch.mock.calls[0]?.[0].headers.get("authorization")).toBe("Bearer admin");
    });

    it("keeps the removal when the cleanup after it fails, and logs it for the sweep", async () => {
        const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);

        workerFetch.mockImplementation(async (request) => {
            const body = await request.text();

            calls.push(`erase:${body}`);

            return body.includes("check") ? Response.json({ erasable: true }) : Response.json({ error: "boom" }, { status: 500 });
        });

        await expect(withControlPlaneErasure(adminDouble(), { DB: {}, LUNORA_ADMIN_TOKEN: "admin" }).removeUser({ userId: "usr_me" })).resolves.toBeUndefined();

        expect(calls).toStrictEqual([
            `erase:${JSON.stringify({ check: true, userId: "usr_me" })}`,
            "auth:usr_me",
            `erase:${JSON.stringify({ userId: "usr_me" })}`,
        ]);
        expect(logged).toHaveBeenCalledWith(expect.stringContaining("orphaned-membership sweep"), 500);

        logged.mockRestore();
    });

    it("does not remove the user when the erasure fails", async () => {
        workerFetch.mockResolvedValue(Response.json({ error: "boom" }, { status: 500 }));

        await expect(withControlPlaneErasure(adminDouble(), { DB: {}, LUNORA_ADMIN_TOKEN: "admin" }).removeUser({ userId: "usr_me" })).rejects.toThrow(
            "the user was not removed",
        );
        expect(calls).toStrictEqual([]);
    });

    it("does not remove the user while they are an organization's only owner, and says how to resolve it", async () => {
        workerFetch.mockResolvedValue(
            Response.json(
                { error: 'The user is the only owner of "Acme". Promote another member to owner…', organizations: [{ id: "org_1", name: "Acme" }] },
                { status: 409 },
            ),
        );

        const removal = withControlPlaneErasure(adminDouble(), { DB: {}, LUNORA_ADMIN_TOKEN: "admin" }).removeUser({ userId: "usr_me" });

        await expect(removal).rejects.toMatchObject({ code: "LAST_ORGANIZATION_OWNER", message: expect.stringContaining('only owner of "Acme"') });
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

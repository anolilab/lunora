import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/internal";
import { DELETED_ACTOR, eraseUser } from "../lunora/account";
import { beforeAccountDeletion } from "../src/account-deletion";
import { ensureAuth } from "../src/auth";
import { handleAccountEraseRoute } from "../src/deploy/routes/account";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * Self-service account deletion. It removes the user's memberships and takes
 * their id out of the audit log, which keeps its entries; it is refused while the
 * user is an organization's only owner.
 */

const authState = vi.hoisted(() => {
    return { createdOptions: [] as Record<string, unknown>[] };
});

const workerFetch = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());

// eslint-disable-next-line vitest/prefer-import-in-mock -- partial stubs, which the real module types reject
vi.mock("@lunora/auth", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();

    return {
        ...actual,
        createAuth: (options: Record<string, unknown>) => {
            authState.createdOptions.push(options);

            return {};
        },
        ensureMigrated: () => Promise.resolve(),
        lunoraD1Adapter: () => {
            return {};
        },
    };
});

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

const deletes = (ops: ReturnType<typeof makeCtx>["ops"]): string[] => ops.flatMap((op) => (op.kind === "delete" ? [op.id] : []));

describe("account erasure", () => {
    it("refuses a sole owner, names the organization, and writes nothing", async () => {
        const { ctx, ops } = makeCtx({
            auditLog: [{ _id: "a1", actorUserId: "usr_me", organizationId: "org_1" }],
            members: [member("m1", "org_1", "usr_me"), member("m2", "org_1", "usr_other", "admin")],
            organizations: [{ _id: "org_1", name: "Acme" }],
        });

        const result = await eraseUser.handler(ctx, { userId: "usr_me" });

        expect(result).toStrictEqual({ erased: false, soleOwnerOf: [{ id: "org_1", name: "Acme" }] });
        expect(ops).toStrictEqual([]);
    });

    it("does not count an organization already scheduled for deletion", async () => {
        const { ctx, ops } = makeCtx({
            auditLog: [],
            members: [member("m1", "org_1", "usr_me")],
            organizations: [{ _id: "org_1", deletionRequestedAt: 5, name: "Acme" }],
        });

        await expect(eraseUser.handler(ctx, { userId: "usr_me" })).resolves.toStrictEqual({ erased: true });
        expect(deletes(ops)).toStrictEqual(["m1"]);
    });

    it("removes every membership of a user who shares ownership, and no one else's", async () => {
        const { ctx, ops } = makeCtx({
            auditLog: [],
            members: [
                member("m1", "org_1", "usr_me"),
                member("m2", "org_1", "usr_other"),
                member("m3", "org_2", "usr_me", "member"),
                member("m4", "org_2", "usr_other"),
            ],
            organizations: [
                { _id: "org_1", name: "Acme" },
                { _id: "org_2", name: "Globex" },
            ],
        });

        await expect(eraseUser.handler(ctx, { userId: "usr_me" })).resolves.toStrictEqual({ erased: true });
        expect(deletes(ops).toSorted((a, b) => a.localeCompare(b))).toStrictEqual(["m1", "m3"]);
    });

    it("replaces the user as the audit actor and keeps the entries", async () => {
        const { ctx, ops } = makeCtx({
            auditLog: [
                { _id: "a1", action: "project.create", actorUserId: "usr_me", organizationId: "org_1" },
                { _id: "a2", action: "member.add", actorUserId: "usr_other", organizationId: "org_1" },
                { _id: "a3", action: "project.delete", actorUserId: "usr_me", organizationId: "org_2" },
            ],
            members: [],
            organizations: [],
        });

        await eraseUser.handler(ctx, { userId: "usr_me" });

        expect(deletes(ops)).toStrictEqual([]);
        expect(ops).toStrictEqual([
            { id: "a1", kind: "patch", patch: { actorUserId: DELETED_ACTOR } },
            { id: "a3", kind: "patch", patch: { actorUserId: DELETED_ACTOR } },
        ]);
    });
});

describe("account erasure route", () => {
    const environmentWith = (result: unknown): RouterEnv =>
        ({
            __lunoraCtx: {
                runAction: () => Promise.reject(new Error("unused")),
                runMutation: (reference: unknown) =>
                    reference === internal.account.eraseUser ? Promise.resolve(result) : Promise.reject(new Error("unexpected")),
                runQuery: () => Promise.reject(new Error("unused")),
            },
        }) as RouterEnv;
    const eraseRequest = (body: unknown): Request => new Request("https://cloud.test/v1/account/erase", { body: JSON.stringify(body), method: "POST" });

    it("answers 409 naming the organizations a sole owner holds", async () => {
        const response = await handleAccountEraseRoute(
            eraseRequest({ userId: "usr_me" }),
            environmentWith({ erased: false, soleOwnerOf: [{ id: "org_1", name: "Acme" }] }),
        );

        expect(response.status).toBe(409);
        await expect(response.json()).resolves.toMatchObject({ error: expect.stringContaining('"Acme"') });
    });

    it("refuses a body without a user id", async () => {
        const response = await handleAccountEraseRoute(eraseRequest({}), environmentWith({ erased: true }));

        expect(response.status).toBe(400);
    });
});

describe("account deletion hook", () => {
    beforeEach(() => {
        workerFetch.mockReset();
    });

    it("is enabled on the auth instance, with the hook", async () => {
        await ensureAuth({ AUTH_SECRET: "s".repeat(32), DB: {}, LUNORA_ADMIN_TOKEN: "admin" }, "https://cloud.test");

        const options = authState.createdOptions[0] as { user?: { deleteUser?: { beforeDelete?: unknown; enabled?: boolean } } };

        expect(options.user?.deleteUser?.enabled).toBe(true);
        expect(options.user?.deleteUser?.beforeDelete).toBeTypeOf("function");
    });

    it("refuses the deletion when the admin token is not configured", async () => {
        await expect(beforeAccountDeletion({ DB: {} })({ id: "usr_me" })).rejects.toThrow("Your account was not deleted");
        expect(workerFetch).not.toHaveBeenCalled();
    });

    it("refuses the deletion with the route's message for a sole owner", async () => {
        workerFetch.mockResolvedValue(Response.json({ error: 'You are the only owner of "Acme".' }, { status: 409 }));

        await expect(beforeAccountDeletion({ DB: {}, LUNORA_ADMIN_TOKEN: "admin" })({ id: "usr_me" })).rejects.toThrow('You are the only owner of "Acme".');

        const request = workerFetch.mock.calls[0]?.[0];

        expect(request?.headers.get("authorization")).toBe("Bearer admin");
        await expect(request?.json()).resolves.toStrictEqual({ userId: "usr_me" });
    });

    it("refuses the deletion when the erasure fails", async () => {
        workerFetch.mockResolvedValue(new Response("boom", { status: 500 }));

        await expect(beforeAccountDeletion({ DB: {}, LUNORA_ADMIN_TOKEN: "admin" })({ id: "usr_me" })).rejects.toThrow("Your account was not deleted");
    });

    it("lets the deletion proceed once the control plane is cleared", async () => {
        workerFetch.mockResolvedValue(Response.json({ erased: true }));

        await expect(beforeAccountDeletion({ DB: {}, LUNORA_ADMIN_TOKEN: "admin" })({ id: "usr_me" })).resolves.toBeUndefined();
    });
});

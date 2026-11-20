import { createAuth } from "@lunora/auth";
import { admin } from "@lunora/auth/plugins";
import { memoryAdapter } from "better-auth/adapters/memory";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/internal";
import { eraseUser, soleOwnedOrganizations } from "../lunora/account";
import { adminRemovalGuard } from "../src/admin-removal";
import type { AuthEnv } from "../src/auth";
import { handleAccountEraseRoute } from "../src/deploy/routes/account";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * better-auth's own `POST /admin/remove-user`, the auth UI's "remove user"
 * action, runs over a real better-auth instance with the cloud's guard plugin.
 * The control plane behind it is the real erase route over the real account
 * functions and an in-memory table set, so a refusal is checked by what was
 * written: nothing in the auth tables, nothing in the control plane's.
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

const PASSWORD = "correct horse battery staple";

const member = (id: string, organizationId: string, userId: string, role = "owner") => {
    return { _id: id, createdAt: 1, organizationId, role, userId };
};

type Ops = ReturnType<typeof makeCtx>["ops"];

interface Harness {
    adminHeaders: Headers;
    adminId: string;
    // `any` so the admin plugin's endpoints are reachable without re-deriving the generic chain.
    auth: any;
    database: Record<string, Record<string, unknown>[]>;
    erasureBodies: unknown[];
    ops: Ops;
    signUp: (email: string) => Promise<string>;
    userHeaders: (email: string) => Promise<Headers>;
}

const cookieOf = async (auth: Harness["auth"], email: string): Promise<Headers> => {
    const response = await auth.api.signInEmail({ body: { email, password: PASSWORD }, returnHeaders: true });
    const headers = new Headers();

    headers.set("cookie", response.headers.get("set-cookie") as string);

    return headers;
};

/** A real auth instance with the admin plugin and the guard, over the control plane's tables in `members`. */
const harness = async (members: ReturnType<typeof member>[]): Promise<Harness> => {
    const { ctx, ops } = makeCtx({ auditLog: [], members, organizations: [{ _id: "org_1", name: "Acme" }] });
    const erasureBodies: unknown[] = [];
    const routerEnvironment = {
        __lunoraCtx: {
            runAction: vi.fn<() => Promise<unknown>>(),
            runMutation: async (reference: unknown, args: never) => {
                if (reference !== internal.account.eraseUser) {
                    throw new Error("unexpected mutation");
                }

                return eraseUser.handler(ctx, args);
            },
            runQuery: async (reference: unknown, args: never) => {
                if (reference !== internal.account.soleOwnedOrganizations) {
                    throw new Error("unexpected query");
                }

                return soleOwnedOrganizations.handler(ctx, args);
            },
        },
    } as unknown as RouterEnv;

    workerFetch.mockImplementation(async (request) => {
        erasureBodies.push(await request.clone().json());

        return handleAccountEraseRoute(request, routerEnvironment);
    });

    const database: Harness["database"] = { account: [], session: [], user: [], verification: [] };
    const env = { DB: null, LUNORA_ADMIN_TOKEN: "admin" } as AuthEnv;
    const auth = createAuth({
        baseURL: "http://localhost",
        database: memoryAdapter(database),
        emailAndPassword: { enabled: true },
        plugins: [admin({ defaultRole: "user" }), adminRemovalGuard(env)],
        secret: "x".repeat(32),
    }) as Harness["auth"];

    const signUp = async (email: string): Promise<string> => {
        const result = await auth.api.signUpEmail({ body: { email, name: email, password: PASSWORD } });

        return result.user.id as string;
    };

    const adminId = await signUp("root@example.com");

    (database.user.find((row) => row.id === adminId) as Record<string, unknown>).role = "admin";

    return {
        adminHeaders: await cookieOf(auth, "root@example.com"),
        adminId,
        auth,
        database,
        erasureBodies,
        ops,
        signUp,
        userHeaders: (email) => cookieOf(auth, email),
    };
};

describe("admin remove-user", () => {
    beforeEach(() => {
        workerFetch.mockReset();
    });

    it("refuses an organization's only owner and writes nothing", async () => {
        expect.assertions(6);

        const members = [member("m1", "org_1", "usr_pending"), member("m2", "org_1", "usr_other", "admin")];
        const h = await harness(members);
        const ownerId = await h.signUp("owner@example.com");

        members[0].userId = ownerId;
        await h.userHeaders("owner@example.com");

        const sessionsBefore = h.database.session.filter((row) => row.userId === ownerId).length;

        await expect(h.auth.api.removeUser({ body: { userId: ownerId }, headers: h.adminHeaders })).rejects.toMatchObject({
            body: { code: "SOLE_ORGANIZATION_OWNER", message: expect.stringContaining('"Acme"') as unknown },
        });

        expect(h.database.user.some((row) => row.id === ownerId)).toBe(true);
        expect(sessionsBefore).toBeGreaterThan(0);
        expect(h.database.session.filter((row) => row.userId === ownerId)).toHaveLength(sessionsBefore);
        expect(h.erasureBodies).toStrictEqual([{ check: true, userId: ownerId }]);
        expect(h.ops).toStrictEqual([]);
    });

    it("removes an owner the organization does not depend on, and cleans up after it", async () => {
        expect.assertions(5);

        const members = [member("m1", "org_1", "usr_pending"), member("m2", "org_1", "usr_co")];
        const h = await harness(members);
        const ownerId = await h.signUp("owner@example.com");

        members[0].userId = ownerId;
        await h.userHeaders("owner@example.com");

        await expect(h.auth.api.removeUser({ body: { userId: ownerId }, headers: h.adminHeaders })).resolves.toStrictEqual({ success: true });

        expect(h.database.user.some((row) => row.id === ownerId)).toBe(false);
        expect(h.database.session.some((row) => row.userId === ownerId)).toBe(false);
        expect(h.erasureBodies).toStrictEqual([{ check: true, userId: ownerId }, { userId: ownerId }]);
        expect(h.ops.flatMap((op) => (op.kind === "delete" ? [op.id] : []))).toStrictEqual(["m1"]);
    });

    it("refuses a caller who may not delete users before asking about anyone's organizations", async () => {
        expect.assertions(3);

        const h = await harness([]);
        const targetId = await h.signUp("target@example.com");

        await h.signUp("plain@example.com");

        await expect(h.auth.api.removeUser({ body: { userId: targetId }, headers: await h.userHeaders("plain@example.com") })).rejects.toMatchObject({
            statusCode: 403,
        });
        expect(h.database.user.some((row) => row.id === targetId)).toBe(true);
        expect(workerFetch).not.toHaveBeenCalled();
    });

    it("cleans up nothing when the endpoint itself refuses the removal", async () => {
        expect.assertions(2);

        const h = await harness([member("m1", "org_1", "usr_pending"), member("m2", "org_1", "usr_co")]);

        await expect(h.auth.api.removeUser({ body: { userId: "usr_missing" }, headers: h.adminHeaders })).rejects.toMatchObject({ statusCode: 404 });
        expect(h.erasureBodies).toStrictEqual([{ check: true, userId: "usr_missing" }]);
    });
});

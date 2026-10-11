import { beforeEach, describe, expect, it, vi } from "vitest";

import { internal } from "../lunora/_generated/internal";
import { ACCOUNT_EXPORT_FORMAT, DELETED_ACTOR, eraseUser } from "../lunora/account";
import { beforeAccountDeletion } from "../src/account-deletion";
import { ensureAuth } from "../src/auth";
import type { AuthRecordReader } from "../src/deploy/routes/account";
import { handleAccountEraseRoute, handleAccountExportRoute, readAccountProfile } from "../src/deploy/routes/account";
import type { RouterEnv } from "../src/deploy/routes/shared";
import { makeCtx } from "./_helpers/fake-ctx";

/**
 * Self-service account deletion and the account export's profile. The deletion
 * removes the user's memberships and takes their id out of the audit log, which
 * keeps its entries; it is refused while the user is an organization's only owner.
 */

type AuthRecords = Record<string, Record<string, unknown>[]>;

const authState = vi.hoisted(() => {
    const records: AuthRecords = {};

    return { createdOptions: [] as Record<string, unknown>[], records, userId: undefined as string | undefined };
});

/** A better-auth adapter double over `records`, matching `where` by equality. */
const fakeAdapter = (records: AuthRecords): AuthRecordReader => {
    const select = (model: string, where: { field: string; value: string }[]) =>
        (records[model] ?? []).filter((row) => where.every(({ field, value }) => row[field] === value));

    return {
        findMany: <T>(query: { model: string; where: { field: string; value: string }[] }) => Promise.resolve(select(query.model, query.where) as T[]),
        findOne: <T>(query: { model: string; where: { field: string; value: string }[] }) =>
            Promise.resolve((select(query.model, query.where)[0] ?? null) as T | null),
    };
};

const workerFetch = vi.hoisted(() => vi.fn<(request: Request) => Promise<Response>>());

// eslint-disable-next-line vitest/prefer-import-in-mock -- partial stubs, which the real module types reject
vi.mock("@lunora/auth", async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();

    return {
        ...actual,
        createAuth: (options: Record<string, unknown>) => {
            authState.createdOptions.push(options);

            return {
                // Read through to the current records, so a test can set them after the instance is built.
                $context: Promise.resolve({
                    adapter: {
                        findMany: (query: never) => fakeAdapter(authState.records).findMany(query),
                        findOne: (query: never) => fakeAdapter(authState.records).findOne(query),
                    },
                }),
                api: { getSession: () => Promise.resolve(authState.userId === undefined ? null : { user: { id: authState.userId } }) },
            };
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

describe("account export profile", () => {
    const records = {
        account: [
            { accessToken: "gho_secret", accountId: "42", providerId: "github", userId: "usr_me" },
            { password: "hash", providerId: "credential", userId: "usr_me" },
            { providerId: "google", userId: "usr_other" },
        ],
        passkey: [{ publicKey: "pk", userId: "usr_me" }],
        user: [{ createdAt: new Date(1000), email: "me@example.de", emailVerified: true, id: "usr_me", name: "Me" }],
    };

    it("reads the profile and sign-in methods from the auth records, without credentials", async () => {
        const profile = await readAccountProfile(fakeAdapter(records), "usr_me");

        expect(profile).toStrictEqual({ createdAt: 1000, email: "me@example.de", name: "Me", signInMethods: ["credential", "github", "passkey"] });
    });

    it("answers null when the auth layer has no user row", async () => {
        await expect(readAccountProfile(fakeAdapter(records), "usr_gone")).resolves.toBeNull();
    });

    it("adds the profile to the control plane's export under the new format", async () => {
        authState.records = records;
        authState.userId = "usr_me";
        await ensureAuth({ AUTH_SECRET: "s".repeat(32), DB: {} }, "https://cloud.test");

        const document = { auditEntries: [], exportedAt: 1, format: ACCOUNT_EXPORT_FORMAT, memberships: [], truncated: false };
        const environment = {
            __lunoraCtx: {
                runAction: () => Promise.reject(new Error("unused")),
                runMutation: () => Promise.reject(new Error("unused")),
                runQuery: (reference: unknown) =>
                    reference === internal.account.exportMine ? Promise.resolve(document) : Promise.reject(new Error("unexpected")),
            },
        } as RouterEnv;

        const response = await handleAccountExportRoute(new Request("https://cloud.test/v1/account/export"), environment);
        const exported = await response.json();

        expect(exported).toStrictEqual({
            ...document,
            format: "lunora-account-export/2",
            profile: { createdAt: 1000, email: "me@example.de", name: "Me", signInMethods: ["credential", "github", "passkey"] },
        });
        expect(JSON.stringify(exported)).not.toMatch(/gho_secret|"hash"/u);
    });

    it("refuses an anonymous caller", async () => {
        authState.userId = undefined;

        const environment = {
            __lunoraCtx: {
                runAction: () => Promise.reject(new Error("unused")),
                runMutation: () => Promise.reject(new Error("unused")),
                runQuery: () => Promise.reject(new Error("unexpected read")),
            },
        } as RouterEnv;

        const response = await handleAccountExportRoute(new Request("https://cloud.test/v1/account/export"), environment);

        expect(response.status).toBe(401);
    });
});

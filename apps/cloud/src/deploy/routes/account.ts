import { internal } from "../../../lunora/_generated/internal";
import type { EraseUserResult, SoleOwnedOrganization } from "../../../lunora/account";
import { currentAuth } from "../../auth";
import type { RouterEnv } from "./shared";
import { jsonError, rejected, requireContext } from "./shared";

/** The slice of better-auth's database adapter the profile read uses. */
export interface AuthRecordReader {
    findMany: <T>(query: { model: string; where: { field: string; value: string }[] }) => Promise<T[]>;
    findOne: <T>(query: { model: string; where: { field: string; value: string }[] }) => Promise<T | null>;
}

/** The account profile in the export: what the authentication layer holds about the user. */
export interface AccountProfile {
    createdAt: number | null;
    email: string;
    name: string | null;
    /** `credential` (email and password), an OAuth provider id such as `github`, and `passkey`. */
    signInMethods: string[];
}

const epochOf = (value: unknown): number | null => {
    if (value instanceof Date) {
        return value.getTime();
    }

    if (typeof value === "number") {
        return value;
    }

    return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : null;
};

/**
 * Read a user's profile from the authentication layer's own records: the user
 * row, the provider of each linked account, and whether a passkey is
 * registered. `null` when there is no user row.
 *
 * Fields are picked one by one: an account row also holds the password hash and
 * the OAuth tokens, and none of that belongs in an export.
 */
export const readAccountProfile = async (adapter: AuthRecordReader, userId: string): Promise<AccountProfile | null> => {
    const user = await adapter.findOne<{ createdAt?: unknown; email?: unknown; name?: unknown }>({ model: "user", where: [{ field: "id", value: userId }] });

    if (user === null || typeof user.email !== "string") {
        return null;
    }

    const byUser = [{ field: "userId", value: userId }];
    // The passkey table exists only with the plugin; a store without it answers with an error.
    const [accounts, passkeys] = await Promise.all([
        adapter.findMany<{ providerId?: unknown }>({ model: "account", where: byUser }),
        adapter.findMany<unknown>({ model: "passkey", where: byUser }).catch(() => []),
    ]);
    const methods = new Set(accounts.flatMap((account) => (typeof account.providerId === "string" ? [account.providerId] : [])));

    if (passkeys.length > 0) {
        methods.add("passkey");
    }

    return {
        createdAt: epochOf(user.createdAt),
        email: user.email,
        name: typeof user.name === "string" && user.name !== "" ? user.name : null,
        signInMethods: [...methods].toSorted((a, b) => a.localeCompare(b)),
    };
};

/**
 * `GET /v1/account/export` — the signed-in caller's account export (GDPR Art. 15
 * and Art. 20): the control plane's part from `account.exportMine`, plus the
 * profile, read here because only the edge reaches the authentication layer.
 */
export const handleAccountExportRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const auth = currentAuth();
    const session = await auth?.api.getSession({ headers: request.headers });
    const userId = session?.user?.id;

    if (!auth || !userId) {
        return jsonError(401, "not signed in");
    }

    const document = await context.runQuery<Record<string, unknown>>(internal.account.exportMine, {});
    const { adapter } = await auth.$context;
    const profile = await readAccountProfile(adapter, userId);

    return Response.json({ ...document, profile }, { headers: { "cache-control": "no-store" } });
};

/**
 * `POST /v1/account/erase` — the control plane's half of removing an account,
 * called in-process with the admin token:
 *
 * - `{ userId, check: true }` from the self-service before-delete hook: writes
 *   nothing, and answers 409 naming the organizations while the user is the only
 *   owner of any (`account.soleOwnedOrganizations`). Only this call refuses.
 * - `{ userId }` from the self-service after-delete hook: removes the
 *   memberships and anonymises the audit actor (`account.eraseUser`), and
 *   answers the organizations that were left without an owner.
 * - `{ userId, operator: true }` from the orphaned-membership sweep: the same,
 *   except that it is refused while the user is the only owner of an
 *   organization. The refusal is a 409 naming the organizations, as the check's
 *   is, and nothing is written. The operator's `removeUser` checks with
 *   `{ userId, check: true }` before the auth cascade instead.
 */
export const handleAccountEraseRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | { check?: unknown; operator?: unknown; userId?: unknown };

    if (typeof body?.userId !== "string" || body.userId === "") {
        return jsonError(400, "userId is required");
    }

    if (body.operator !== undefined && typeof body.operator !== "boolean") {
        return jsonError(400, "operator must be a boolean");
    }

    if (body.check === true && body.operator === true) {
        return jsonError(400, "an operator removal checks inside the erasure, so it takes no separate check");
    }

    if (body.check === true) {
        const soleOwnerOf = await context.runQuery<SoleOwnedOrganization[]>(internal.account.soleOwnedOrganizations, { userId: body.userId });

        if (soleOwnerOf.length === 0) {
            return Response.json({ erasable: true });
        }

        const names = soleOwnerOf.map((organization) => `"${organization.name}"`).join(", ");

        return Response.json(
            {
                error: `You are the only owner of ${names}. Transfer ownership or delete the organization before deleting your account.`,
                organizations: soleOwnerOf,
            },
            { status: 409 },
        );
    }

    const { ownerless, refused } = await context.runMutation<EraseUserResult>(internal.account.eraseUser, {
        userId: body.userId,
        ...(body.operator === true ? { operator: true } : {}),
    });

    if (refused !== undefined) {
        const names = refused.map((organization) => `"${organization.name}"`).join(", ");

        return Response.json(
            {
                error: `The user is the only owner of ${names}. Promote another member to owner or delete the organization, then remove the user again.`,
                organizations: refused,
            },
            { status: 409 },
        );
    }

    if (ownerless.length > 0) {
        // eslint-disable-next-line no-console -- the audit entry is in each organization's log; this is the operator's signal
        console.error("[account] account deletion left organizations without an owner", ownerless);
    }

    return Response.json({ erased: true, ownerless });
};

/**
 * `POST /v1/organizations/owners` — make an existing member of an organization
 * one of its owners (`members.operatorPromoteOwner`). Admin token only: it is
 * how an operator resolves a removal refused because the user is the only owner
 * of an organization. Body `{ organizationId, userId }`. 404 when the user is
 * not a member of the organization; never demotes anyone.
 */
export const handleOwnerPromoteRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | { organizationId?: unknown; userId?: unknown };

    if (typeof body?.organizationId !== "string" || body.organizationId === "" || typeof body.userId !== "string" || body.userId === "") {
        return jsonError(400, "organizationId and userId are required");
    }

    try {
        const result = await context.runMutation<{ memberId: string; promoted: boolean }>(internal.members.operatorPromoteOwner, {
            organizationId: body.organizationId,
            userId: body.userId,
        });

        return Response.json({ ok: true, ...result });
    } catch (error) {
        return rejected(error, "promotion refused");
    }
};

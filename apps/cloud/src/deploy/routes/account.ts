import { internal } from "../../../lunora/_generated/internal";
import type { EraseUserResult, SoleOwnedOrganization } from "../../../lunora/account";
import { currentAuth } from "../../auth";
import type { RouterEnv } from "./shared";
import { jsonError, requireContext } from "./shared";

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
    const accounts = await adapter.findMany<{ providerId?: unknown }>({ model: "account", where: byUser });
    // The passkey table exists only with the plugin; a store without it answers with an error.
    const passkeys = await adapter.findMany<unknown>({ model: "passkey", where: byUser }).catch(() => []);
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
 * `POST /v1/account/erase` — the control plane's half of an account deletion,
 * called in-process with the admin token. Two calls, one on each side of the
 * authentication layer deleting the account:
 *
 * - `{ userId, check: true }` from its before-delete hook: writes nothing, and
 *   answers 409 naming the organizations while the user is the only owner of any
 *   (`account.soleOwnedOrganizations`).
 * - `{ userId }` from its after-delete hook and from the orphaned-membership
 *   sweep: removes the memberships and anonymises the audit actor
 *   (`account.eraseUser`), and answers the organizations that were left without
 *   an owner.
 */
export const handleAccountEraseRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | { check?: unknown; userId?: unknown };

    if (typeof body?.userId !== "string" || body.userId === "") {
        return jsonError(400, "userId is required");
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

    const { ownerless } = await context.runMutation<EraseUserResult>(internal.account.eraseUser, { userId: body.userId });

    if (ownerless.length > 0) {
        // eslint-disable-next-line no-console -- the audit entry is in each organization's log; this is the operator's signal
        console.error("[account] account deletion left organizations without an owner", ownerless);
    }

    return Response.json({ erased: true, ownerless });
};

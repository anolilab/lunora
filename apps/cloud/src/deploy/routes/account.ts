import { internal } from "../../../lunora/_generated/internal";
import type { EraseUserResult } from "../../../lunora/account";
import type { RouterEnv } from "./shared";
import { jsonError, requireContext } from "./shared";

/**
 * `POST /v1/account/erase` — remove what the control plane holds about a user
 * whose account is being deleted (`account.eraseUser`). Called in-process by the
 * authentication layer's before-delete hook, with the admin token. Answers 409,
 * naming the organizations, while the user is the only owner of any.
 */
export const handleAccountEraseRoute = async (request: Request, environment: RouterEnv): Promise<Response> => {
    const context = requireContext(environment);
    const body = (await request.json().catch(() => null)) as null | { userId?: unknown };

    if (typeof body?.userId !== "string" || body.userId === "") {
        return jsonError(400, "userId is required");
    }

    const result = await context.runMutation<EraseUserResult>(internal.account.eraseUser, { userId: body.userId });

    if (!result.erased) {
        const names = result.soleOwnerOf.map((organization) => `"${organization.name}"`).join(", ");

        return Response.json(
            {
                error: `You are the only owner of ${names}. Transfer ownership or delete the organization before deleting your account.`,
                organizations: result.soleOwnerOf,
            },
            { status: 409 },
        );
    }

    return Response.json({ erased: true });
};

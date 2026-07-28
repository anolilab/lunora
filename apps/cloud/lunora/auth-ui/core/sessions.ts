/**
 * Active-sessions flow (security): list the user's sessions and revoke one or
 * all-others. A thin specialization of the resource engine.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthSession, Controller } from "./types";

interface SessionsActions {
    refetch: () => Promise<void>;
    revoke: (token: string) => Promise<void>;
    revokeOthers: () => Promise<void>;
}

type SessionsController = Controller<ResourceState<AuthSession>, SessionsActions>;

const createSessionsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): SessionsController => {
    const resource = createResourceController<AuthSession>(context, async (context_) => assertOk(await context_.authClient.listSessions()).data ?? [], options);

    return {
        actions: {
            refetch: resource.refetch,
            revoke: (token: string) => resource.mutate(async () => assertOk(await context.authClient.revokeSession({ token }))),
            revokeOthers: () => resource.mutate(async () => assertOk(await context.authClient.revokeOtherSessions())),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { SessionsActions, SessionsController };
export { createSessionsController };

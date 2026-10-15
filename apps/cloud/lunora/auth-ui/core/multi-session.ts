/**
 * Multi-session (account switching): the accounts signed in *on this device*,
 * with switch and sign-out-just-this-one.
 *
 * Not to be confused with `sessions.ts`, which lists this account's sessions
 * across every device. The two read almost-identically-named endpoints and mean
 * opposite things — this one is "who else can I switch to here", that one is
 * "where else am I logged in".
 *
 * Switching replaces the active session cookie, so it fires `onSessionChange`
 * and hands the app a chance to re-resolve identity before anything renders
 * stale user data.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthDeviceSession, Controller } from "./types";

interface DeviceSessionsActions {
    refetch: () => Promise<void>;
    /** Sign out one of the device's accounts without touching the others. */
    revoke: (sessionToken: string) => Promise<void>;
    /** Make `sessionToken` the active account. */
    setActive: (sessionToken: string) => Promise<void>;
}

type DeviceSessionsController = Controller<ResourceState<AuthDeviceSession>, DeviceSessionsActions>;

const createDeviceSessionsController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): DeviceSessionsController => {
    const resource = createResourceController<AuthDeviceSession>(
        context,
        async (context_) => {
            return { items: assertOk(await context_.authClient.multiSession.listDeviceSessions()).data ?? [] };
        },
        options,
    );

    return {
        actions: {
            refetch: resource.refetch,
            revoke: (sessionToken: string) =>
                resource.mutate(async () => {
                    assertOk(await context.authClient.multiSession.revoke({ sessionToken }));
                    context.onSessionChange?.();
                }),
            setActive: (sessionToken: string) =>
                resource.mutate(async () => {
                    assertOk(await context.authClient.multiSession.setActive({ sessionToken }));
                    context.onSessionChange?.();
                }),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { DeviceSessionsActions, DeviceSessionsController };
export { createDeviceSessionsController };

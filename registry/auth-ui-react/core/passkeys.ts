/**
 * Passkeys flow (security): list the user's registered passkeys and add, rename,
 * or remove one. A thin specialization of the resource engine.
 *
 * `addPasskey` triggers a WebAuthn ceremony in the browser, so it can resolve
 * with no payload at all when the user dismisses the platform prompt — that is a
 * cancellation, not a failure, and must not surface as an error banner.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthPasskey, Controller } from "./types";

interface PasskeysActions {
    /** Start the WebAuthn registration ceremony. Resolves quietly if the user cancels. */
    add: (name?: string) => Promise<void>;
    refetch: () => Promise<void>;
    remove: (id: string) => Promise<void>;
    rename: (id: string, name: string) => Promise<void>;
}

type PasskeysController = Controller<ResourceState<AuthPasskey>, PasskeysActions>;

const createPasskeysController = (context: ControllerContext, options: { autoLoad?: boolean } = {}): PasskeysController => {
    const resource = createResourceController<AuthPasskey>(
        context,
        async (context_) => assertOk(await context_.authClient.passkey.listUserPasskeys()).data ?? [],
        options,
    );

    return {
        actions: {
            add: (name?: string) =>
                resource.mutate(async () => {
                    const trimmed = name?.trim();
                    const response = await context.authClient.passkey.addPasskey(trimmed === undefined || trimmed === "" ? undefined : { name: trimmed });

                    // A dismissed platform prompt resolves undefined — nothing was
                    // registered, but nothing went wrong either.
                    if (response) {
                        assertOk(response);
                    }
                }),
            refetch: resource.refetch,
            remove: (id: string) => resource.mutate(async () => assertOk(await context.authClient.passkey.deletePasskey({ id }))),
            rename: (id: string, name: string) =>
                resource.mutate(async () => assertOk(await context.authClient.passkey.updatePasskey({ id, name: name.trim() }))),
        },
        destroy: resource.destroy,
        getState: resource.getState,
        subscribe: resource.subscribe,
    };
};

export type { PasskeysActions, PasskeysController };
export { createPasskeysController };

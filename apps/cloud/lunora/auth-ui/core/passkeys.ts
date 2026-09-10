/**
 * Passkeys flow (security): list the user's registered passkeys and add, rename,
 * or remove one. A thin specialization of the resource engine.
 *
 * `addPasskey` triggers a WebAuthn ceremony in the browser. Dismissing the
 * platform prompt is a cancellation, not a failure, and must not surface as an
 * error banner — but better-auth reports it the same way as a real failure, as a
 * populated `error` with a ceremony-abort code. Those codes are the only way to
 * tell the two apart.
 */
import type { ControllerContext } from "./config";
import type { ResourceState } from "./create-resource-controller";
import { createResourceController } from "./create-resource-controller";
import { assertOk } from "./map-error";
import type { AuthPasskey, Controller } from "./types";

/**
 * WebAuthn outcomes that mean "the user backed out", not "something broke".
 * `@better-auth/passkey` surfaces both as an error payload.
 */
const CANCELLED_CODES = new Set(["ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED", "ERROR_CEREMONY_ABORTED"]);

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
        async (context_) => {
            return { items: assertOk(await context_.authClient.passkey.listUserPasskeys()).data ?? [] };
        },
        options,
    );

    return {
        actions: {
            add: (name?: string) =>
                resource.mutate(async () => {
                    const trimmed = name?.trim();
                    const response = await context.authClient.passkey.addPasskey(trimmed === undefined || trimmed === "" ? undefined : { name: trimmed });

                    // Older/other clients may resolve nothing at all; treat that as a
                    // cancellation too rather than assuming a shape.
                    if (!response || (response.error && CANCELLED_CODES.has(response.error.code ?? ""))) {
                        return;
                    }

                    assertOk(response);
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

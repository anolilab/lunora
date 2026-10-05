/**
 * Device authorization: the browser half of the flow a TV, CLI, or console app
 * starts. The device shows a short code; the user types it here and approves.
 *
 * Approval is a security decision, so nothing is automatic — a code arriving in
 * the URL (`?user_code=…`) prefills the field but never submits it. A link that
 * silently grants access to whatever device sent it is exactly the attack this
 * flow exists to make visible.
 */
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { Controller, FlowStatus } from "./types";

interface DeviceAuthorizationState {
    /** What the user typed (or what the URL prefilled). */
    code: string;
    /** Set once the user has approved or denied, so the view can stop offering both. */
    decision?: "approved" | "denied";
    error?: string;
    status: FlowStatus;
}

interface DeviceAuthorizationActions {
    approve: () => Promise<void>;
    deny: () => Promise<void>;
    setCode: (value: string) => void;
}

type DeviceAuthorizationController = Controller<DeviceAuthorizationState, DeviceAuthorizationActions>;

interface DeviceAuthorizationOptions {
    /** Prefill from the link the device displayed. Never auto-submits. */
    userCode?: string;
}

const createDeviceAuthorizationController = (context: ControllerContext, options: DeviceAuthorizationOptions = {}): DeviceAuthorizationController => {
    const store = createStore<DeviceAuthorizationState>({ code: options.userCode ?? "", status: "idle" });

    const decide = async (decision: "approved" | "denied"): Promise<void> => {
        const code = store.get().code.trim();

        if (code === "") {
            store.update({ error: context.localization.deviceCodeRequired, status: "error" });

            return;
        }

        if (store.get().status === "submitting") {
            return;
        }

        store.update({ error: undefined, status: "submitting" });

        try {
            await (decision === "approved"
                ? context.authClient.device.approve({ userCode: code }).then(assertOk)
                : context.authClient.device.deny({ userCode: code }).then(assertOk));

            store.update({ decision, status: "success" });
        } catch (error) {
            context.onError?.(error);
            store.update({ error: mapAuthError(error, context.localization, context.localization.deviceFailed), status: "error" });
        }
    };

    return {
        actions: {
            approve: () => decide("approved"),
            deny: () => decide("denied"),
            setCode: (value: string) => {
                store.update({ code: value, error: undefined, status: "idle" });
            },
        },
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { DeviceAuthorizationActions, DeviceAuthorizationController, DeviceAuthorizationOptions, DeviceAuthorizationState };
export { createDeviceAuthorizationController };

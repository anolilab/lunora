/**
 * Two-factor setup (security): enable 2FA (password → TOTP URI + backup codes),
 * verify the first code to activate, and disable. A bespoke multi-step controller
 * over {@link createStore}.
 */
import type { ControllerContext } from "./config";
import { assertOk, mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { Controller, FieldState, FlowStatus } from "./types";
import { required } from "./validators";

interface TwoFactorSetupState {
    backupCodes: ReadonlyArray<string>;
    code: FieldState;
    error?: string;
    password: FieldState;
    status: FlowStatus;
    /** `start` collects the password; `verify` shows the QR/URI; `enabled` is done. */
    step: "enabled" | "start" | "verify";
    /** The `otpauth://` URI to render as a QR code (verify step). */
    totpUri?: string;
}

interface TwoFactorSetupActions {
    disable: () => Promise<void>;
    enable: () => Promise<void>;
    reset: () => void;
    setCode: (value: string) => void;
    setPassword: (value: string) => void;
    verify: () => Promise<void>;
}

type TwoFactorSetupController = Controller<TwoFactorSetupState, TwoFactorSetupActions>;

const emptyField = (): FieldState => {
    return { touched: false, value: "" };
};

const initialState = (): TwoFactorSetupState => {
    return {
        backupCodes: [],
        code: emptyField(),
        password: emptyField(),
        status: "idle",
        step: "start",
    };
};

const createTwoFactorSetupController = (context: ControllerContext): TwoFactorSetupController => {
    const store = createStore<TwoFactorSetupState>(initialState());

    const fail = (error: unknown, fallback: string): void => {
        context.onError?.(error);
        store.update({ error: mapAuthError(error, context.localization, fallback), status: "error" });
    };

    const enable = async (): Promise<void> => {
        const state = store.get();
        const error = required(state.password.value, context.localization.passwordRequired);

        if (error) {
            store.update({ password: { ...state.password, error, touched: true }, status: "error" });

            return;
        }

        store.update({ error: undefined, password: { ...state.password, error: undefined }, status: "submitting" });

        try {
            const { data } = assertOk(await context.authClient.twoFactor.enable({ password: state.password.value }));

            store.update({ backupCodes: data?.backupCodes ?? [], status: "idle", step: "verify", totpUri: data?.totpURI });
        } catch (error_) {
            fail(error_, context.localization.genericError);
        }
    };

    const verify = async (): Promise<void> => {
        const state = store.get();
        const error = required(state.code.value, context.localization.otpRequired);

        if (error) {
            store.update({ code: { ...state.code, error, touched: true }, status: "error" });

            return;
        }

        store.update({ code: { ...state.code, error: undefined }, error: undefined, status: "submitting" });

        try {
            assertOk(await context.authClient.twoFactor.verifyTotp({ code: state.code.value.trim() }));
            store.update({ status: "success", step: "enabled" });
        } catch (error_) {
            fail(error_, context.localization.twoFactorFailed);
        }
    };

    const disable = async (): Promise<void> => {
        const state = store.get();
        const error = required(state.password.value, context.localization.passwordRequired);

        if (error) {
            store.update({ password: { ...state.password, error, touched: true }, status: "error" });

            return;
        }

        store.update({ error: undefined, status: "submitting" });

        try {
            assertOk(await context.authClient.twoFactor.disable({ password: state.password.value }));
            store.set(initialState());
        } catch (error_) {
            fail(error_, context.localization.genericError);
        }
    };

    return {
        actions: {
            disable,
            enable,
            reset: () => {
                store.set(initialState());
            },
            setCode: (value: string) => {
                store.update({ code: { ...store.get().code, value }, error: undefined, status: "idle" });
            },
            setPassword: (value: string) => {
                store.update({ error: undefined, password: { ...store.get().password, value }, status: "idle" });
            },
            verify,
        },
        destroy: () => {
            store.set(initialState());
        },
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { TwoFactorSetupActions, TwoFactorSetupController, TwoFactorSetupState };
export { createTwoFactorSetupController };

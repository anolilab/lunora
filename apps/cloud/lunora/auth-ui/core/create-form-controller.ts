/**
 * The reusable form-controller engine. Every credential flow (sign-in, sign-up,
 * forgot/reset password, magic link, email OTP, two-factor) is a thin
 * specialization: it declares its fields + validators and a `submit` function,
 * and this engine owns all the field-state / validation / lifecycle bookkeeping.
 * This is the single biggest duplication win — flow files stay ~20 lines.
 *
 * The engine implements the external-store contract ({@link FormController}) on
 * the shared {@link createStore}: `getState` returns a stable reference between
 * changes (required by React's `useSyncExternalStore`) and a fresh object on
 * every mutation (so every framework's reactivity sees the change).
 *
 * Flows whose fields come from the server declare {@link FormControllerOptions.prefill}
 * rather than seeding themselves — see `organization-settings.ts`.
 */
import type { ControllerContext } from "./config";
import type { Localization } from "./localization";
import { mapAuthError } from "./map-error";
import { createStore } from "./store";
import type { FieldState, FormActions, FormController, FormState } from "./types";

/** What a successful `submit` returns to drive the success state + navigation. */
interface FormSubmitResult {
    /** Navigate here (via `nav.replace`) on success. */
    redirectTo?: string;
    /** Success line to display. */
    successMessage?: string;
}

interface FieldSpec<TField extends string> {
    initial?: string;
    /** Return an error string, or `undefined` when the value is valid. */
    validate?: (value: string, values: Record<TField, string>, localization: Localization) => string | undefined;
}

interface FormControllerOptions<TField extends string> {
    /** Message shown when `submit` throws without a more specific one. */
    fallbackError: (localization: Localization) => string;
    fields: Record<TField, FieldSpec<TField>>;

    /**
     * Load the initial values from the server. While it runs, `state.loading` is
     * true; the resolved values land in a single transition, so views never see a
     * half-filled form. Rejections go to `onError` and leave the fields empty —
     * an unreachable server shouldn't block the user from typing.
     */
    prefill?: (context: ControllerContext) => Promise<Partial<Record<TField, string>>>;
    /** Whether a successful submit changed the session (triggers `onSessionChange`). */
    sessionChanging?: boolean;
    /** Perform the flow. Throw to surface an error; return a result to enter success. */
    submit: (values: Record<TField, string>, context: ControllerContext) => Promise<FormSubmitResult | undefined>;
}

const createFormController = <TField extends string>(context: ControllerContext, options: FormControllerOptions<TField>): FormController<TField> => {
    const fieldNames = Object.keys(options.fields) as TField[];

    const buildInitialFields = (): Record<TField, FieldState> => {
        const fields = {} as Record<TField, FieldState>;

        for (const name of fieldNames) {
            fields[name] = { touched: false, value: options.fields[name].initial ?? "" };
        }

        return fields;
    };

    const initialState = (): FormState<TField> => {
        return { fields: buildInitialFields(), loading: options.prefill !== undefined, status: "idle" };
    };

    const store = createStore<FormState<TField>>(initialState());

    const state = (): FormState<TField> => store.get();

    const values = (): Record<TField, string> => {
        const out = {} as Record<TField, string>;

        for (const name of fieldNames) {
            out[name] = state().fields[name].value;
        }

        return out;
    };

    const validateField = (name: TField): string | undefined => options.fields[name].validate?.(state().fields[name].value, values(), context.localization);

    const setField = (name: TField, value: string): void => {
        // Editing after a terminal state returns the form to idle and clears the
        // top-level banner; the edited field's own error clears too.
        const current = state();

        store.set({
            ...current,
            fields: { ...current.fields, [name]: { ...current.fields[name], error: undefined, value } },
            formError: undefined,
            status: current.status === "submitting" ? "submitting" : "idle",
            successMessage: undefined,
        });
    };

    const blur = (name: TField): void => {
        const error = validateField(name);
        const current = state();

        store.set({
            ...current,
            fields: { ...current.fields, [name]: { ...current.fields[name], error, touched: true } },
        });
    };

    const submit = async (): Promise<void> => {
        if (state().status === "submitting") {
            return;
        }

        // Validate every field up front.
        const nextFields = { ...state().fields };
        let hasError = false;

        for (const name of fieldNames) {
            const error = validateField(name);

            nextFields[name] = { ...nextFields[name], error, touched: true };

            if (error) {
                hasError = true;
            }
        }

        if (hasError) {
            store.set({ ...state(), fields: nextFields, formError: undefined, status: "error" });

            return;
        }

        store.set({ ...state(), fields: nextFields, formError: undefined, status: "submitting" });

        try {
            const result = (await options.submit(values(), context)) ?? {};

            store.set({
                ...state(),
                fields: { ...state().fields },
                status: "success",
                successMessage: result.successMessage,
            });

            if (options.sessionChanging) {
                context.onSessionChange?.();
            }

            if (result.redirectTo !== undefined) {
                context.nav.replace(result.redirectTo);
            }
        } catch (error) {
            context.onError?.(error);

            store.set({
                ...state(),
                formError: mapAuthError(error, context.localization, options.fallbackError(context.localization)),
                status: "error",
            });
        }
    };

    const reset = (): void => {
        store.set(initialState());
    };

    /** Re-run `prefill` and seed the fields in one transition. */
    const load = async (): Promise<void> => {
        if (!options.prefill) {
            return;
        }

        store.set({ ...state(), loading: true });

        try {
            const seeded = await options.prefill(context);
            const current = state();
            const fields = { ...current.fields };

            for (const name of fieldNames) {
                const value = seeded[name];

                if (value !== undefined) {
                    fields[name] = { ...fields[name], error: undefined, touched: false, value };
                }
            }

            store.set({ ...current, fields, loading: false });
        } catch (error) {
            context.onError?.(error);
            store.set({ ...state(), loading: false });
        }
    };

    if (options.prefill) {
        void load();
    }

    const actions: FormActions<TField> = { blur, load, reset, setField, submit };

    return {
        actions,
        destroy: store.clear,
        getState: store.get,
        subscribe: store.subscribe,
    };
};

export type { FieldSpec, FormControllerOptions, FormSubmitResult };
export { createFormController };

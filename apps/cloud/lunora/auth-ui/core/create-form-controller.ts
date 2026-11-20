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
import type { FieldState, FlowStatus, FormActions, FormController, FormState } from "./types";

/**
 * The status an edit leaves behind.
 *
 * Editing after a terminal state returns the form to idle (clearing the banner
 * with it) — except while a submit is in flight, where "idle" would re-enable
 * the button and let a second request out. Exported because the bespoke
 * controllers alongside this engine (`email-otp.ts`) have to answer the same
 * question, and the exception is the part that gets dropped when it is
 * re-typed: in the OTP flow a second `sendVerificationOtp` invalidates the code
 * the first one mailed, so a user correcting a typo mid-request is left holding
 * a code that no longer works.
 */
const statusAfterEdit = (status: FlowStatus): FlowStatus => (status === "submitting" ? "submitting" : "idle");

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

    /*
     * Which `load` is current. `reset()` can start a second one while the first
     * is still in flight, and without this the slower response wins — restoring
     * older server data over the newer read.
     */
    let generation = 0;

    /**
     * Fields the user has typed into. Not `FieldState.touched` — that means
     * "has been blurred", which drives error display and stays false while
     * someone is still typing. This is the narrower question `load` needs:
     * may a late prefill still overwrite this value?*
     */
    const edited = new Set<TField>();

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
        edited.add(name);

        const current = state();

        store.set({
            ...current,
            fields: { ...current.fields, [name]: { ...current.fields[name], error: undefined, value } },
            formError: undefined,
            status: statusAfterEdit(current.status),
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

    /**
     * Re-run `prefill` and seed the fields in one transition.
     *
     * A resolved prefill never overwrites a field the user has already typed
     * into, and never seeds at all once a submit is in flight or has done. Both
     * guards exist because `prefill` is a network read racing a human: a slow
     * `getSession` that lands after someone typed — or after they *saved* —
     * would otherwise silently restore the old value over their edit, which
     * reads as "the save didn't work". The race widens with anything else on the
     * page that also reads the session, so it is not a theoretical one.
     */
    const load = async (): Promise<void> => {
        if (!options.prefill) {
            return;
        }

        generation += 1;

        const ticket = generation;

        store.set({ ...state(), loading: true });

        try {
            const seeded = await options.prefill(context);

            if (ticket !== generation) {
                return;
            }

            const current = state();

            if (current.status === "submitting" || current.status === "success") {
                store.set({ ...current, loading: false });

                return;
            }

            const fields = { ...current.fields };

            for (const name of fieldNames) {
                const value = seeded[name];

                if (value !== undefined && !edited.has(name)) {
                    fields[name] = { ...fields[name], error: undefined, touched: false, value };
                }
            }

            store.set({ ...current, fields, loading: false });
        } catch (error) {
            context.onError?.(error);

            if (ticket === generation) {
                store.set({ ...state(), loading: false });
            }
        }
    };

    const reset = (): void => {
        edited.clear();
        store.set(initialState());

        // `initialState()` restores `loading: true` for a prefilled form, so
        // without re-running the load the form spins forever.
        if (options.prefill) {
            void load();
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
export { createFormController, statusAfterEdit };

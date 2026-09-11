/**
 * The form engine every kit form runs on — one field-bag, one validator pass,
 * one submit, over the shared {@link createStore}.
 *
 * It is here rather than in a view because a form's *behaviour* is identical in
 * React and Svelte and its *markup* is not: what changes per framework is how a
 * snapshot reaches the DOM, which is three lines of adapter. Every rule about
 * when submit is disabled, what clears an error, and whether a double-click can
 * fire twice lives in one place and is tested once.
 */
import { mapError } from "./map-error";
import { createStore } from "./store";
import type { FlowStatus } from "./types";

/** One field's declaration: its initial value and an optional synchronous check. */
interface FieldSpec {
    initial?: string;
    /** Return a message to reject, or `undefined` to accept. */
    validate?: (value: string) => string | undefined;
}

interface FormState<TFields extends string> {
    /** Per-field messages from the last validation pass. */
    errors: Partial<Record<TFields, string>>;
    /** The submit-level error — a thrown server error, mapped. */
    formError?: string;
    status: FlowStatus;
    values: Record<TFields, string>;
}

interface FormController<TFields extends string> {
    destroy: () => void;
    getState: () => FormState<TFields>;
    /** Reset to the declared initial values and clear every error. */
    reset: () => void;

    /** Set one field and clear its error — typing is how a user dismisses one. */
    setValue: (field: TFields, value: string) => void;

    /**
     * Validate, then run `submit`. Resolves `true` only when the handler ran and
     * did not throw.
     *
     * Callers that act on success — a navigation, a dialog close — must use this
     * boolean and never re-read `state.formError`: it is cleared at the start of
     * every attempt, so a submit that was skipped as a duplicate reads exactly
     * like one that succeeded.
     */
    submit: () => Promise<boolean>;
    subscribe: (onChange: () => void) => () => void;
}

interface FormOptions<TFields extends string> {
    fields: Record<TFields, FieldSpec>;
    onSubmit: (values: Record<TFields, string>) => Promise<unknown>;
    /** Called after a submit resolves without throwing. */
    onSuccess?: (values: Record<TFields, string>) => void;
}

const createFormController = <TFields extends string>(options: FormOptions<TFields>): FormController<TFields> => {
    const names = Object.keys(options.fields) as TFields[];
    const initial = Object.fromEntries(names.map((name) => [name, options.fields[name].initial ?? ""])) as Record<TFields, string>;
    const store = createStore<FormState<TFields>>({ errors: {}, status: "idle", values: { ...initial } });

    const validate = (values: Record<TFields, string>): Partial<Record<TFields, string>> => {
        const errors: Partial<Record<TFields, string>> = {};

        for (const name of names) {
            const message = options.fields[name].validate?.(values[name]);

            if (message) {
                errors[name] = message;
            }
        }

        return errors;
    };

    return {
        destroy: () => {
            store.clear();
        },
        getState: store.get,
        reset: () => {
            store.set({ errors: {}, status: "idle", values: { ...initial } });
        },
        setValue: (field, value) => {
            const state = store.get();

            store.set({
                ...state,
                errors: { ...state.errors, [field]: undefined },
                formError: undefined,
                values: { ...state.values, [field]: value },
            });
        },
        submit: async () => {
            const state = store.get();

            // A second submit while one is in flight is a double-click, not an
            // intent. Swallowing it here is what keeps every view from having to
            // remember to disable its own button.
            if (state.status === "busy") {
                return false;
            }

            const errors = validate(state.values);

            if (Object.keys(errors).length > 0) {
                store.update({ errors, formError: undefined, status: "error" });

                return false;
            }

            store.update({ errors: {}, formError: undefined, status: "busy" });

            try {
                await options.onSubmit(state.values);
            } catch (error) {
                store.update({ formError: mapError(error), status: "error" });

                return false;
            }

            store.update({ status: "success" });
            options.onSuccess?.(state.values);

            return true;
        },
        subscribe: store.subscribe,
    };
};

export type { FieldSpec, FormController, FormOptions, FormState };
export { createFormController };

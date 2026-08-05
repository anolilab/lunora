import type { JSX } from "solid-js";

import type { FormActions, FormState } from "../core/types";
import { Field } from "./primitives";

/** Stop the browser's native submit and run the controller action (async or not). */
const onSubmit =
    (action: () => unknown) =>
    (event: Event): void => {
        event.preventDefault();
        void action();
    };

/** A {@link Field} wired to a form controller's field: value, blur, and change. */
interface FormFieldProps<TField extends string> {
    actions: Pick<FormActions<TField>, "blur" | "setField">;
    autoComplete?: string;
    field: TField;
    label: string;
    /** HTML `name` attribute; defaults to the field key. */
    name?: string;
    state: Pick<FormState<TField>, "fields">;
    type?: "email" | "password" | "text";
}

const FormField = <TField extends string>(props: FormFieldProps<TField>): JSX.Element => (
    <Field
        autoComplete={props.autoComplete}
        field={props.state.fields[props.field]}
        label={props.label}
        name={props.name ?? props.field}
        onBlur={() => {
            props.actions.blur(props.field);
        }}
        onChange={(value) => {
            props.actions.setField(props.field, value);
        }}
        type={props.type}
    />
);

export { FormField, onSubmit };

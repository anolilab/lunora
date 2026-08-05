"use client";

import type { ReactElement } from "react";

import type { FormActions, FormState } from "../core";
import { Field } from "./primitives";

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

const FormField = <TField extends string>({ actions, autoComplete, field, label, name, state, type }: FormFieldProps<TField>): ReactElement => (
    <Field
        autoComplete={autoComplete}
        field={state.fields[field]}
        label={label}
        name={name ?? field}
        onBlur={() => {
            actions.blur(field);
        }}
        onChange={(value) => {
            actions.setField(field, value);
        }}
        type={type}
    />
);

export { FormField };

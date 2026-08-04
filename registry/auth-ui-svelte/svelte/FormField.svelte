<!-- A Field wired to a form controller's field: value, blur, and change. -->
<script lang="ts" generics="TField extends string">
    import type { FieldState, FormActions } from "../core/types";
    import Field from "./Field.svelte";

    let {
        actions,
        autoComplete,
        field,
        fields,
        label,
        name,
        type,
    }: {
        actions: Pick<FormActions<TField>, "blur" | "setField">;
        autoComplete?: AutoFill;
        field: TField;
        fields: Record<TField, FieldState>;
        label: string;
        /** HTML `name` attribute; defaults to the field key. */
        name?: string;
        type?: "email" | "password" | "text";
    } = $props();
</script>

<Field
    {autoComplete}
    field={fields[field]}
    {label}
    name={name ?? field}
    onBlur={() => {
        actions.blur(field);
    }}
    onChange={(value) => {
        actions.setField(field, value);
    }}
    {type}
/>

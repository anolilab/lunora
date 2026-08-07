<script setup lang="ts" generic="TField extends string">
import type { FieldState, FormActions } from "../core/types";
import Field from "./Field.vue";

// A Field wired to a form controller's field: value, blur, and change. The
// optional `name` overrides the HTML `name` attribute (defaults to the field key).
defineProps<{
    actions: Pick<FormActions<TField>, "blur" | "setField">;
    autoComplete?: string;
    field: TField;
    fields: Record<TField, FieldState>;
    label: string;
    name?: string;
    type?: "email" | "password" | "text";
}>();
</script>

<template>
    <Field
        :field="fields[field]"
        :label="label"
        :name="name ?? field"
        :type="type"
        :autoComplete="autoComplete"
        @blur="actions.blur(field)"
        @change="actions.setField(field, $event)"
    />
</template>

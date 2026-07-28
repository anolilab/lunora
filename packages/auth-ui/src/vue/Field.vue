<script setup lang="ts">
import { computed, useId } from "vue";

import type { FieldState } from "../core/types";

// A labelled text input wired to a core FieldState. Emits `blur` and `change`
// (with the next value) so the card forwards them to the controller.
const props = withDefaults(
    defineProps<{
        autoComplete?: string;
        field: FieldState;
        label: string;
        name: string;
        placeholder?: string;
        type?: "email" | "password" | "text";
    }>(),
    {
        type: "text",
    },
);

const emit = defineEmits<{
    blur: [];
    change: [value: string];
}>();

const id = useId();
const errorId = `${id}-error`;
const showError = computed(() => props.field.touched && props.field.error !== undefined);
</script>

<template>
    <div class="lunora-auth-field">
        <label class="lunora-auth-field__label" :for="id">{{ label }}</label>
        <input
            :id="id"
            class="lunora-auth-field__input"
            :name="name"
            :type="type"
            :value="field.value"
            :autocomplete="autoComplete"
            :placeholder="placeholder"
            :aria-invalid="showError"
            :aria-describedby="showError ? errorId : undefined"
            @blur="emit('blur')"
            @input="emit('change', ($event.target as HTMLInputElement).value)"
        />
        <p v-if="showError" :id="errorId" class="lunora-auth-field__error">{{ field.error }}</p>
    </div>
</template>

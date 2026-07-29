<script setup lang="ts">
// The live requirement checklist under a password field.
//
// A checklist rather than a bare strength bar: "weak" tells someone their
// password is unacceptable without telling them what to change. The bar is
// derived from the same requirements so the two can never disagree.
//
// `aria-live="polite"` on the list, because the ticks change as the user types
// and a screen reader should hear progress without being interrupted mid-word.
import { computed } from "vue";

import { passwordRequirements, passwordScore } from "../core/password-policy";
import { useAuthUIContextRef } from "./provider";

const props = defineProps<{
    value: string;
}>();

const context = useAuthUIContextRef();
// Computed, not read in `setup()`: `setup()` runs once, and this has to
// re-derive on every keystroke. Reading the context through the ref also keeps
// the policy following the one identity change discovery makes.
const requirements = computed(() => passwordRequirements(props.value, context.value.localization, context.value.password));
const fillWidth = computed(() => `${String(Math.round(passwordScore(requirements.value) * 100))}%`);
</script>

<template>
    <div v-if="value !== ''" class="lunora-auth-strength">
        <div class="lunora-auth-strength__bar">
            <span class="lunora-auth-strength__fill" :style="{ width: fillWidth }" />
        </div>
        <ul aria-live="polite" class="lunora-auth-strength__list">
            <li
                v-for="requirement in requirements"
                :key="requirement.label"
                class="lunora-auth-strength__item"
                :class="{ 'lunora-auth-strength__item--met': requirement.met }"
            >
                <span aria-hidden="true">{{ requirement.met ? "✓" : "○" }}</span> {{ requirement.label }}
            </li>
        </ul>
    </div>
</template>

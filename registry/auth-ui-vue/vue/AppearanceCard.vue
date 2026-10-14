<script setup lang="ts">
// Light / dark / system. Not a better-auth feature at all — it lives here
// because account settings is where people look for it.
//
// Toggle buttons rather than `role="radio"`: a radio group owes the user
// arrow-key navigation and a single roving tab stop, and declaring the role
// without implementing that is worse than not claiming it. `aria-pressed` on
// three ordinary buttons is honest about what the keyboard actually does.
import type { ThemeMode } from "../core/theme-mode";
import { createThemeModeController, THEME_MODES } from "../core/theme-mode";
import AuthCard from "./AuthCard.vue";
import { useAuthUI } from "./provider";
import { useController } from "./use-controller";

const { localization: t } = useAuthUI();
const { actions, state } = useController(() => createThemeModeController());

const THEME_LABELS: Record<ThemeMode, string> = { dark: t.themeDark, light: t.themeLight, system: t.themeSystem };

const themeLabel = (mode: ThemeMode): string => THEME_LABELS[mode];
</script>

<template>
    <AuthCard :title="t.appearance">
        <div class="lunora-auth-segmented" role="group" :aria-label="t.appearance">
            <button
                v-for="mode in THEME_MODES"
                :key="mode"
                class="lunora-auth-segmented__option"
                type="button"
                :aria-pressed="state.mode === mode"
                @click="actions.setMode(mode)"
            >
                {{ themeLabel(mode) }}
            </button>
        </div>
    </AuthCard>
</template>

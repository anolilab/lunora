<script setup lang="ts">
// Light / dark / system. Not a better-auth feature at all — it lives here
// because account settings is where people look for it.
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
        <div class="lunora-auth-segmented" role="radiogroup">
            <button
                v-for="mode in THEME_MODES"
                :key="mode"
                class="lunora-auth-segmented__option"
                type="button"
                role="radio"
                :aria-checked="state.mode === mode"
                @click="actions.setMode(mode)"
            >
                {{ themeLabel(mode) }}
            </button>
        </div>
    </AuthCard>
</template>

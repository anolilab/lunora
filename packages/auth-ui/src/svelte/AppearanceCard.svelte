<!--
    Light / dark / system. Not a better-auth feature at all — it lives here
    because account settings is where people look for it.

    Toggle buttons rather than `role="radio"`: a radio group owes the user
    arrow-key navigation and a single roving tab stop, and declaring the role
    without implementing that is worse than not claiming it. `aria-pressed` on
    three ordinary buttons is honest about what the keyboard actually does.
-->
<script lang="ts">
    import type { ThemeMode } from "../core/theme-mode";
    import { createThemeModeController, THEME_MODES } from "../core/theme-mode";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";

    const t = useAuthUI().localization;
    // The theme controller needs no auth context, so the factory ignores the one
    // the store seam hands it.
    const { actions, state: theme } = controllerStore(() => createThemeModeController());

    const label: Record<ThemeMode, string> = { dark: t.themeDark, light: t.themeLight, system: t.themeSystem };
</script>

<AuthCard title={t.appearance}>
    <div aria-label={t.appearance} class="lunora-auth-segmented" role="group">
        {#each THEME_MODES as mode (mode)}
            <button
                aria-pressed={$theme.mode === mode}
                class="lunora-auth-segmented__option"
                onclick={() => {
                    actions.setMode(mode);
                }}
                type="button"
            >
                {label[mode]}
            </button>
        {/each}
    </div>
</AuthCard>

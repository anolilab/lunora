<!--
    The live requirement checklist under a password field.

    A checklist rather than a bare strength bar: "weak" tells someone their
    password is unacceptable without telling them what to change. The bar is
    derived from the same requirements so the two can never disagree.

    `aria-live="polite"` on the list, because the ticks change as the user types
    and a screen reader should hear progress without being interrupted mid-word.
-->
<script lang="ts">
    import { passwordRequirements, passwordScore } from "../core/password-policy";
    import { useAuthUI } from "./context";

    let { value }: { value: string } = $props();

    const context = useAuthUI();
    // `$derived`, not a one-time read: this re-derives on every keystroke.
    const requirements = $derived(passwordRequirements(value, context.localization, context.password));
    const fillWidth = $derived(`${String(Math.round(passwordScore(requirements) * 100))}%`);
</script>

{#if value !== ""}
    <div class="lunora-auth-strength">
        <div class="lunora-auth-strength__bar">
            <span class="lunora-auth-strength__fill" style="width:{fillWidth}"></span>
        </div>
        <ul class="lunora-auth-strength__list" aria-live="polite">
            {#each requirements as requirement (requirement.label)}
                <li class="lunora-auth-strength__item{requirement.met ? ' lunora-auth-strength__item--met' : ''}">
                    <span aria-hidden="true">{requirement.met ? "✓" : "○"}</span>
                    {requirement.label}
                </li>
            {/each}
        </ul>
    </div>
{/if}

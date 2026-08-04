<!-- Sign in with a username instead of an email. -->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createUsernameSignInController } from "../core/username";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormField from "./FormField.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "username", "UsernameSignInCard");
    const { actions, state: form } = controllerStore(createUsernameSignInController);
</script>

{#if enabled}
    <AuthCard title={t.signIn}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit();
            }}
        >
            <FormBanner error={$form.formError} />
            <FormField {actions} autoComplete="username" field="username" fields={$form.fields} label={t.usernameLabel} />
            <FormField {actions} autoComplete="current-password" field="password" fields={$form.fields} label={t.passwordLabel} type="password" />
            <SubmitButton pending={$form.status === "submitting"}>{t.signIn}</SubmitButton>
        </form>
    </AuthCard>
{/if}

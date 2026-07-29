<!-- Sign in with a username instead of an email. -->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createUsernameSignInController } from "../core/username";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
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
            <Field
                autoComplete="username"
                field={$form.fields.username}
                label={t.usernameLabel}
                name="username"
                onBlur={() => {
                    actions.blur("username");
                }}
                onChange={(value) => {
                    actions.setField("username", value);
                }}
            />
            <Field
                autoComplete="current-password"
                field={$form.fields.password}
                label={t.passwordLabel}
                name="password"
                onBlur={() => {
                    actions.blur("password");
                }}
                onChange={(value) => {
                    actions.setField("password", value);
                }}
                type="password"
            />
            <SubmitButton pending={$form.status === "submitting"}>{t.signIn}</SubmitButton>
        </form>
    </AuthCard>
{/if}

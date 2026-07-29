<!-- Sign in with a phone number and password. -->
<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { createPhoneSignInController } from "../core/phone-number";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "phoneNumber", "PhoneSignInCard");
    const { actions, state: form } = controllerStore(createPhoneSignInController);
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
                autoComplete="tel"
                field={$form.fields.phoneNumber}
                label={t.phoneLabel}
                name="phoneNumber"
                onBlur={() => {
                    actions.blur("phoneNumber");
                }}
                onChange={(value) => {
                    actions.setField("phoneNumber", value);
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

<script lang="ts">
    import { createTwoFactorVerifyController } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let {
        method,
        trustDevice,
    }: {
        method?: "otp" | "totp";
        trustDevice?: boolean;
    } = $props();

    const t = useAuthUI().localization;
    // `method` / `trustDevice` are read once at mount.
    const { actions, state: form } = controllerStore((context) => createTwoFactorVerifyController(context, { method, trustDevice }));
</script>

<AuthCard title={t.twoFactor}>
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
            autoComplete="one-time-code"
            field={$form.fields.code}
            label={t.codeLabel}
            name="code"
            onBlur={() => {
                actions.blur("code");
            }}
            onChange={(value) => {
                actions.setField("code", value);
            }}
        />
        <SubmitButton pending={$form.status === "submitting"}>{t.twoFactor}</SubmitButton>
    </form>
</AuthCard>

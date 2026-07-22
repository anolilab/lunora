<script lang="ts">
    import { createSignUpController } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let { signInHref = "/sign-in" }: { signInHref?: string } = $props();

    const t = useAuthUI().localization;
    const { actions, state: form } = controllerStore(createSignUpController);
</script>

<AuthCard title={t.signUp}>
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
            autoComplete="name"
            field={$form.fields.name}
            label={t.nameLabel}
            name="name"
            onBlur={() => {
                actions.blur("name");
            }}
            onChange={(value) => {
                actions.setField("name", value);
            }}
        />
        <Field
            autoComplete="email"
            field={$form.fields.email}
            label={t.emailLabel}
            name="email"
            onBlur={() => {
                actions.blur("email");
            }}
            onChange={(value) => {
                actions.setField("email", value);
            }}
            type="email"
        />
        <Field
            autoComplete="new-password"
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
        <SubmitButton pending={$form.status === "submitting"}>{t.signUp}</SubmitButton>
    </form>
    {#snippet footer()}
        <AuthLink href={signInHref}>{t.haveAccount}</AuthLink>
    {/snippet}
</AuthCard>

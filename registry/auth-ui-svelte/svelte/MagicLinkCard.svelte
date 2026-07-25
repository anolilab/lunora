<script lang="ts">
    import { createMagicLinkController, isFlowEnabled } from "../core";
    import AuthCard from "./AuthCard.svelte";
    import AuthLink from "./AuthLink.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    let { signInHref = "/sign-in" }: { signInHref?: string } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "magicLink", "MagicLinkCard");
    const { actions, state: form } = controllerStore(createMagicLinkController);
</script>

{#if enabled}
    <AuthCard title={t.magicLink}>
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.submit();
            }}
        >
            <FormBanner error={$form.formError} success={$form.successMessage} />
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
            <SubmitButton pending={$form.status === "submitting"}>{t.magicLink}</SubmitButton>
        </form>
        {#snippet footer()}
            <AuthLink href={signInHref}>{t.backToSignIn}</AuthLink>
        {/snippet}
    </AuthCard>
{/if}

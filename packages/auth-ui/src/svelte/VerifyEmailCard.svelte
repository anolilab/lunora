<!--
    The page the verification link lands on. It consumes the token on mount and
    redirects, so the only states a user sees are "working" and "that link is no
    longer good".
-->
<script lang="ts">
    import { queryParameter } from "../core/browser-location";
    import { createVerifyEmailController } from "../core/verify-email";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";

    let {
        token,
    }: {
        /** Defaults to `?token=` from the URL. */
        token?: string;
    } = $props();

    const t = useAuthUI().localization;
    const { actions, state: flow } = controllerStore((context) => createVerifyEmailController(context, { token: token ?? queryParameter("token") }));
</script>

<AuthCard title={t.verifyEmail}>
    <FormBanner error={$flow.error} />
    {#if $flow.status === "submitting" || $flow.status === "idle"}
        <p class="lunora-auth-note">{t.verifyEmailVerifying}</p>
    {/if}
    {#if $flow.status === "error"}
        <button
            class="lunora-auth-button lunora-auth-button--secondary"
            onclick={() => {
                void actions.verify();
            }}
            type="button"
        >
            {t.verifyEmailResend}
        </button>
    {/if}
</AuthCard>

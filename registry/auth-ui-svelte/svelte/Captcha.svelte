<!--
    A CAPTCHA widget for the sign-in / sign-up forms.

    Place it inside the card; it publishes a token that `client.ts` attaches to
    outgoing auth requests via `captchaHeaders()` (see `core/captcha.ts` — the
    token is not threaded through the flows). It renders nothing without a
    `siteKey`, so it is safe to mount unconditionally.
-->
<script lang="ts">
    import type { CaptchaProvider } from "../core/captcha";
    import { renderCaptcha } from "../core/captcha";
    import { useAuthUI } from "./context";

    let {
        provider,
        siteKey,
    }: {
        provider: CaptchaProvider;
        siteKey?: string;
    } = $props();

    const context = useAuthUI();
    const onError = context.onError;

    let host = $state<HTMLDivElement | undefined>(undefined);

    /*
     * Re-runs when the host element, the provider, or the site key changes; the
     * teardown `renderCaptcha` returns resets the widget and drops any token it
     * produced, so a swapped provider can't leave a stale single-use token behind.
     */
    $effect(() => {
        const element = host;
        const key = siteKey;
        const widgetProvider = provider;

        if (element === undefined || key === undefined || key === "") {
            return undefined;
        }

        return renderCaptcha(element, { onError, provider: widgetProvider, siteKey: key });
    });
</script>

{#if siteKey !== undefined && siteKey !== ""}
    <div bind:this={host} class="lunora-auth-captcha"></div>
{/if}

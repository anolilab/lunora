<script setup lang="ts">
// A CAPTCHA widget for the sign-in / sign-up forms.
//
// Place it inside the card; it publishes a token that `client.ts` attaches to
// outgoing auth requests via `captchaHeaders()` (see `core/captcha.ts` — the
// token is not threaded through the flows). It renders nothing without a
// `siteKey`, so it is safe to mount unconditionally.
import { useTemplateRef, watchPostEffect } from "vue";

import type { CaptchaProvider } from "../core/captcha";
import { renderCaptcha } from "../core/captcha";
import { useAuthUI } from "./provider";

const props = defineProps<{
    provider: CaptchaProvider;
    siteKey?: string;
}>();

const context = useAuthUI();
const host = useTemplateRef<HTMLDivElement>("host");

/*
 * `post`, not the default `pre`: a template ref is only populated once the DOM
 * has been patched, so a `pre` effect would run against a null host on the very
 * first mount. Re-runs on a provider/site-key change, and the teardown returned
 * by `renderCaptcha` is registered as the cleanup — Vue calls it before each
 * re-run and once more when the component unmounts, which is what stops a stale
 * single-use token from outliving the widget.
 */
watchPostEffect((onCleanup) => {
    const element = host.value;
    const { provider, siteKey } = props;

    if (element === null || siteKey === undefined || siteKey === "") {
        return;
    }

    onCleanup(renderCaptcha(element, { onError: context.onError, provider, siteKey }));
});
</script>

<template>
    <div v-if="siteKey !== undefined && siteKey !== ''" ref="host" class="lunora-auth-captcha" />
</template>

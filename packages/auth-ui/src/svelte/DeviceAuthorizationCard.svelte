<!--
    Approve or deny a device code.

    A code arriving in the URL prefills the field and never submits: a link that
    silently grants access to whatever device sent it is exactly what this flow
    exists to make visible.
-->
<script lang="ts">
    import { queryParameter } from "../core/browser-location";
    import { createDeviceAuthorizationController } from "../core/device-authorization";
    import { isFlowEnabled } from "../core/flow-gate";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";

    let {
        userCode,
    }: {
        /** Defaults to `?user_code=` from the URL. */
        userCode?: string;
    } = $props();

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "deviceAuthorization", "DeviceAuthorizationCard");
    const { actions, state: flow } = controllerStore((context_) =>
        createDeviceAuthorizationController(context_, { userCode: userCode ?? queryParameter("user_code") }),
    );
</script>

{#if enabled}
    {#if $flow.decision !== undefined}
        <AuthCard title={t.deviceTitle}>
            <FormBanner success={$flow.decision === "approved" ? t.deviceApproved : t.deviceDenied} />
        </AuthCard>
    {:else}
        <AuthCard title={t.deviceTitle}>
            <FormBanner error={$flow.error} />
            <Field field={{ touched: false, value: $flow.code }} label={t.deviceCodeLabel} name="user_code" onBlur={() => {}} onChange={actions.setCode} />
            <div class="lunora-auth-actions">
                <button
                    class="lunora-auth-button"
                    disabled={$flow.status === "submitting"}
                    onclick={() => {
                        void actions.approve();
                    }}
                    type="button"
                >
                    {t.deviceApprove}
                </button>
                <button
                    class="lunora-auth-button lunora-auth-button--secondary"
                    disabled={$flow.status === "submitting"}
                    onclick={() => {
                        void actions.deny();
                    }}
                    type="button"
                >
                    {t.deviceDeny}
                </button>
            </div>
        </AuthCard>
    {/if}
{/if}

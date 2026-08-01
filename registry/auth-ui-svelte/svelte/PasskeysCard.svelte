<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { passkeyLabel } from "../core/labels";
    import { createPasskeysController } from "../core/passkeys";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import Field from "./Field.svelte";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "passkey", "PasskeysCard");
    const { actions, state: res } = controllerStore((context_) => createPasskeysController(context_, { autoLoad: enabled }));

    let name = $state("");
</script>

{#if enabled}
    <AuthCard headingLevel={2} title={t.passkeys}>
        <FormBanner error={$res.error} />
        {#if $res.loading}
            <p class="lunora-auth-card__description">…</p>
        {:else if $res.items.length === 0}
            <p class="lunora-auth-card__description">{t.passkeysEmpty}</p>
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.items as passkey (passkey.id ?? passkeyLabel(passkey, t))}
                    {@const id = passkey.id}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">{passkeyLabel(passkey, t)}</span>
                        {#if id !== undefined}
                            <button
                                class="lunora-auth-link"
                                disabled={$res.busy}
                                onclick={() => {
                                    void actions.remove(id);
                                }}
                                type="button"
                            >
                                {t.remove}
                            </button>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
        <form
            class="lunora-auth-form"
            novalidate
            onsubmit={(event) => {
                event.preventDefault();
                void actions.add(name).then(() => {
                    name = "";
                });
            }}
        >
            <Field
                field={{ touched: false, value: name }}
                label={t.passkeyName}
                name="passkeyName"
                onBlur={() => undefined}
                onChange={(value) => {
                    name = value;
                }}
            />
            <SubmitButton pending={$res.busy}>{t.passkeyAdd}</SubmitButton>
        </form>
    </AuthCard>
{/if}

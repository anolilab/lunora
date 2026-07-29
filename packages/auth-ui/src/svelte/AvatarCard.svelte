<!--
    Avatar upload. Rendered only when the app configured an `avatar.upload`
    handler — without one there is nowhere to put the bytes, and <ProfileCard>'s
    URL field is the honest fallback.
-->
<script lang="ts">
    import { ACCEPT_ATTRIBUTE, createAvatarUploadController } from "../core/avatar";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import UserAvatar from "./UserAvatar.svelte";

    const context = useAuthUI();
    const t = context.localization;
    const { actions, state: avatar } = controllerStore(createAvatarUploadController);

    let picker = $state<HTMLInputElement | undefined>(undefined);
</script>

{#if context.avatar.upload !== undefined}
    <AuthCard title={t.avatar}>
        <FormBanner error={$avatar.error} />
        <div class="lunora-auth-avatar-row">
            <UserAvatar size={64} user={{ image: $avatar.imageUrl }} />
            <div class="lunora-auth-avatar-row__actions">
                <input
                    accept={ACCEPT_ATTRIBUTE}
                    bind:this={picker}
                    class="lunora-auth-visually-hidden"
                    onchange={(event) => {
                        const file = event.currentTarget.files?.[0];

                        // Clear the input so re-picking the same file after a
                        // failure still fires `change` — browsers suppress it when
                        // the value is unchanged.
                        event.currentTarget.value = "";

                        if (file) {
                            void actions.upload(file);
                        }
                    }}
                    type="file"
                />
                <button
                    class="lunora-auth-button"
                    disabled={$avatar.status === "submitting"}
                    onclick={() => {
                        picker?.click();
                    }}
                    type="button"
                >
                    {t.avatarUpload}
                </button>
                {#if $avatar.imageUrl !== undefined && $avatar.imageUrl !== ""}
                    <button
                        class="lunora-auth-button lunora-auth-button--danger"
                        disabled={$avatar.status === "submitting"}
                        onclick={() => {
                            void actions.remove();
                        }}
                        type="button"
                    >
                        {t.avatarRemove}
                    </button>
                {/if}
            </div>
        </div>
    </AuthCard>
{/if}

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

    const pickerId = `lunora-auth-picker-${crypto.randomUUID()}`;
</script>

{#if context.avatar.upload !== undefined}
    <AuthCard title={t.avatar}>
        <FormBanner error={$avatar.error} />
        <div class="lunora-auth-avatar-row">
            <UserAvatar size={64} user={{ image: $avatar.imageUrl }} />
            <div class="lunora-auth-avatar-row__actions">
                <!--
                    A label wrapping the input, not a button that clicks it: the
                    input is the only control, so there is one tab stop, the label
                    text is its accessible name, and Enter or Space opens the
                    picker natively. The input stays focusable and out of the ARIA
                    tree's way — `aria-hidden` on something focusable is what
                    leaves focus with no accessible target.
                -->
                <label class="lunora-auth-button" for={pickerId}>
                    <input
                        accept={ACCEPT_ATTRIBUTE}
                        id={pickerId}
                        class="lunora-auth-visually-hidden"
                        disabled={$avatar.status === "submitting"}
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
                    {t.avatarUpload}
                </label>
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

<script module lang="ts">
    // Per-instance ids: two cards on one page must not collide.
    let counter = 0;
</script>

<script lang="ts">
    import { isFlowEnabled } from "../core/flow-gate";
    import { ROLE_OPTIONS } from "../core/labels";
    import { createMembersController } from "../core/members";
    import AuthCard from "./AuthCard.svelte";
    import { useAuthUI } from "./context";
    import { controllerStore } from "./controller-store";
    import FormBanner from "./FormBanner.svelte";
    import SubmitButton from "./SubmitButton.svelte";

    const uid = `lunora-auth-${(counter += 1)}`;
    const context = useAuthUI();
    const t = context.localization;
    const enabled = isFlowEnabled(context, "organization", "MembersCard");
    const { actions, state: res } = controllerStore((context_) => createMembersController(context_, { autoLoad: enabled }));

    let email = $state("");
    let role = $state<string>("member");

    const invite = (): void => {
        if (email.trim() === "") {
            return;
        }

        void actions.invite(email.trim(), role);
        email = "";
    };
</script>

{#if enabled}
    <AuthCard title={t.members}>
        <FormBanner error={$res.error} />

        {#if $res.loading}
            <p class="lunora-auth-card__description">…</p>
        {:else}
            <ul class="lunora-auth-list">
                {#each $res.members as member (member.id ?? member.userId ?? member.user?.email)}
                    {@const memberId = member.id}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">
                            {member.user?.email ?? member.user?.name ?? member.userId} · {member.role}
                        </span>
                        {#if memberId !== undefined}
                            <button
                                class="lunora-auth-link"
                                disabled={$res.busy}
                                onclick={() => {
                                    void actions.removeMember(memberId);
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

        {#if $res.invitations.length > 0}
            <p class="lunora-auth-card__description">{t.invitations}</p>
            <ul class="lunora-auth-list">
                {#each $res.invitations as invitation (invitation.id ?? invitation.email)}
                    {@const invitationId = invitation.id}
                    <li class="lunora-auth-list__item">
                        <span class="lunora-auth-list__label">
                            {invitation.email} · {invitation.role}
                        </span>
                        {#if invitationId !== undefined}
                            <button
                                class="lunora-auth-link"
                                disabled={$res.busy}
                                onclick={() => {
                                    void actions.cancelInvitation(invitationId);
                                }}
                                type="button"
                            >
                                {t.cancel}
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
                invite();
            }}
        >
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="{uid}-invite-email">{t.inviteEmailLabel}</label>
                <input bind:value={email} class="lunora-auth-field__input" id="{uid}-invite-email" type="email" />
            </div>
            <div class="lunora-auth-field">
                <label class="lunora-auth-field__label" for="{uid}-invite-role">{t.roleLabel}</label>
                <select bind:value={role} class="lunora-auth-field__input" id="{uid}-invite-role">
                    {#each ROLE_OPTIONS as option (option)}
                        <option value={option}>{option}</option>
                    {/each}
                </select>
            </div>
            <SubmitButton pending={$res.busy}>{t.inviteMember}</SubmitButton>
        </form>
    </AuthCard>
{/if}

<script lang="ts">
    import type { PresenceMemberLike } from "../core";
    import { initials, presenceRoster, presenceSummary } from "../core";

    interface Props {
        /** How many avatars to show before collapsing into a `+N`. */
        cap?: number;
        /** The viewer, so their own entry can be labelled and sorted first. */
        currentUserId: string | undefined;
        /** `listPresent`'s rows. `undefined` while the subscription is connecting. */
        members: ReadonlyArray<PresenceMemberLike> | undefined;
    }

    const { cap, currentUserId, members }: Props = $props();

    const roster = $derived(members ? presenceRoster(members, currentUserId, cap) : undefined);
</script>

{#if !roster}
    <div aria-busy="true" class="lu-saas-presence lu-saas-presence--loading"></div>
{:else}
    <div class="lu-saas-presence">
        <ul class="lu-saas-presence__list">
            {#each roster.entries as entry (entry.key)}
                <li class={entry.isSelf ? "lu-saas-avatar lu-saas-avatar--self" : "lu-saas-avatar"} title={entry.isSelf ? `${entry.name} (you)` : entry.name}>
                    {initials(entry.name)}
                </li>
            {/each}
            {#if roster.overflow > 0}
                <li class="lu-saas-avatar lu-saas-avatar--more">+{roster.overflow}</li>
            {/if}
        </ul>
        <span class="lu-saas-presence__summary">{presenceSummary(roster)}</span>
    </div>
{/if}

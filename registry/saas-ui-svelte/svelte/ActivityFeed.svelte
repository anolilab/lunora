<script lang="ts">
    import type { ActivityRow } from "../core";
    import { groupActivityByDay, initials } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";

    interface Props {
        now: number;
        /** Resolve an actor id to a display name — members live in better-auth, not here. */
        resolveActor?: (actorId: string) => string;
        rows: ReadonlyArray<ActivityRow> | undefined;
    }

    const { now, resolveActor, rows }: Props = $props();

    const groups = $derived(rows ? groupActivityByDay(rows, now) : []);
</script>

<Card title="Activity">
    {#if !rows}
        <div aria-busy="true" class="lu-saas-feed lu-saas-feed--loading"></div>
    {:else if rows.length === 0}
        <Empty title="No activity yet" />
    {:else}
        {#each groups as group (group.day)}
            <div class="lu-saas-feed__group">
                <h3 class="lu-saas-feed__day">{group.day}</h3>
                <ul class="lu-saas-feed__list">
                    {#each group.entries as entry (entry.id)}
                        {@const actor = resolveActor?.(entry.actorId) ?? entry.actorId}
                        <li class="lu-saas-feed__entry">
                            <span aria-hidden="true" class="lu-saas-avatar">{initials(actor)}</span>
                            <span class="lu-saas-feed__text"><strong>{actor}</strong> {entry.sentence}</span>
                            <time class="lu-saas-feed__when" datetime={new Date(entry.timestamp).toISOString()}>{entry.when}</time>
                        </li>
                    {/each}
                </ul>
            </div>
        {/each}
    {/if}
</Card>

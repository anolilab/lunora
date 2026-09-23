<script lang="ts">
    import type { OverviewPayload } from "../core";
    import { deriveOverviewStats, isFirstRun } from "../core";
    import Empty from "./Empty.svelte";

    interface Props {
        /** The clock, injected — see the React port for why it is never read from `Date.now()`. */
        now: number;
        /** What `api.saas.overview` resolved to. `undefined` while it is loading. */
        payload: OverviewPayload | undefined;
    }

    const { now, payload }: Props = $props();

    // One `$derived` against the same pure function the React port calls. The
    // reactivity model differs; the stat logic does not exist twice.
    const tiles = $derived(payload ? deriveOverviewStats(payload, now) : []);
</script>

{#if !payload}
    <div aria-busy="true" class="lu-saas-stats lu-saas-stats--loading"></div>
{:else if isFirstRun(payload)}
    <Empty title="Nothing here yet">
        <p>Create your first project and this dashboard fills in — live, in every tab you have open.</p>
    </Empty>
{:else}
    <div class="lu-saas-stats">
        {#each tiles as tile (tile.id)}
            <div class="lu-saas-stat">
                <span class="lu-saas-stat__value">{tile.value}</span>
                <span class="lu-saas-stat__label">{tile.label}</span>
                {#if tile.note}<span class="lu-saas-stat__note">{tile.note}</span>{/if}
            </div>
        {/each}
    </div>
{/if}

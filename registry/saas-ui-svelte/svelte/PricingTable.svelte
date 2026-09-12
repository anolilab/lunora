<script lang="ts">
    import type { Plan, SubscriptionLike } from "../core";
    import { pricingRows } from "../core";

    interface Props {
        /** Start checkout for a plan's provider price id. */
        onSelect: (priceId: string) => unknown;
        plans: ReadonlyArray<Plan>;
        subscription: SubscriptionLike | undefined;
    }

    const { onSelect, plans, subscription }: Props = $props();

    const rows = $derived(pricingRows(plans, subscription));
</script>

<div class="lu-saas-stats">
    {#each rows as row (row.plan.id)}
        <div class={row.current ? "lu-saas-stat lu-saas-stat--current" : "lu-saas-stat"}>
            <span class="lu-saas-stat__label">{row.plan.name}</span>
            <span class="lu-saas-stat__value">{row.price}</span>
            <span class="lu-saas-stat__note">{row.plan.blurb}</span>
            <ul class="lu-saas-list">
                {#each row.plan.features as feature (feature)}
                    <li class="lu-saas-row">{feature}</li>
                {/each}
            </ul>
            {#if row.current}
                <span class="lu-saas-stat__note">Current plan</span>
            {:else if row.purchasable}
                <button
                    class="lu-saas-button"
                    onclick={() => {
                        onSelect(row.priceId ?? "");
                    }}
                    type="button">Choose {row.plan.name}</button
                >
            {/if}
        </div>
    {/each}
</div>

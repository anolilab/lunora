<script lang="ts">
    import type { Plan, SubscriptionLike } from "../core";
    import { currentPlan, seatUsage, subscriptionNotice } from "../core";
    import Card from "./Card.svelte";

    interface Props {
        /** Members in the organisation — the real seat count, not the billed quantity. */
        memberCount: number;
        /** Open the provider's customer portal. */
        onManage: () => unknown;
        plans: ReadonlyArray<Plan>;
        subscription: SubscriptionLike | undefined;
    }

    const { memberCount, onManage, plans, subscription }: Props = $props();

    const plan = $derived(currentPlan(plans, subscription));
    const seats = $derived(seatUsage(plan, memberCount));
    const notice = $derived(subscriptionNotice(subscription));
</script>

<Card subtitle={plan?.name} title="Billing">
    {#snippet actions()}
        <button
            class="lu-saas-button lu-saas-button--quiet"
            onclick={() => {
                onManage();
            }}
            type="button">Manage billing</button
        >
    {/snippet}

    {#if notice}
        <p class="lu-saas-error" role="status">{notice}</p>
    {/if}
    <p>
        {seats.limit === undefined ? `${seats.used} members, unmetered` : `${seats.used} of ${seats.limit} seats used`}
    </p>
    {#if seats.limit !== undefined}
        <progress class="lu-saas-meter" max={1} value={seats.ratio}>{Math.round(seats.ratio * 100)}%</progress>
    {/if}
    {#if seats.over}
        <p class="lu-saas-error" role="alert">This organization is over its seat allowance. Upgrade, or remove members.</p>
    {/if}
</Card>

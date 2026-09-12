<script lang="ts">
    import type { Snippet } from "svelte";

    import type { Plan, SubscriptionLike } from "../core";
    import { isEntitled } from "../core";
    import Empty from "./Empty.svelte";

    /**
     * Render `children` only when the tenant's plan includes `feature`.
     *
     * This decides what to RENDER, never what to allow — the mutation checks the
     * same entitlement server-side, because a gate a user can edit in devtools
     * is a suggestion.
     */
    interface Props {
        children: Snippet;
        fallback?: Snippet;
        /** The capability name declared on a plan's `features`. */
        feature: string;
        plans: ReadonlyArray<Plan>;
        subscription: SubscriptionLike | undefined;
    }

    const { children, fallback, feature, plans, subscription }: Props = $props();

    const entitled = $derived(isEntitled(plans, subscription, feature));
</script>

{#if entitled}
    {@render children()}
{:else if fallback}
    {@render fallback()}
{:else}
    <Empty title={`Your plan does not include ${feature}.`} />
{/if}

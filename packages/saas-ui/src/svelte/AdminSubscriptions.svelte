<script lang="ts">
    import type { AdminSubscriptionRow, OrganizationRow, Plan, SubscriptionsView } from "../core";
    import { DEFAULT_SUBSCRIPTIONS_VIEW, planLabel, selectSubscriptions, subscriptionStateOptions, subscriptionsSubtitle } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";

    interface Props {
        /**
         * Fetch the next page — the paginated query's `loadMore`. Pass it only while
         * more pages remain; without it the rows are read as the whole table.
         */
        onLoadMore?: () => void;
        /** The organisation list, for names. Subscriptions render with ids until it arrives. */
        organizations: ReadonlyArray<OrganizationRow> | undefined;
        plans: ReadonlyArray<Plan>;
        /** The pages loaded so far. `undefined` while the first page is in flight. */
        rows: ReadonlyArray<AdminSubscriptionRow> | undefined;
    }

    const { onLoadMore, organizations, plans, rows }: Props = $props();

    let view = $state<SubscriptionsView>({ ...DEFAULT_SUBSCRIPTIONS_VIEW });

    const visible = $derived(rows ? selectSubscriptions(rows, organizations ?? [], plans, view) : []);
    const states = $derived(rows ? subscriptionStateOptions(rows) : []);
</script>

<Card subtitle={rows ? subscriptionsSubtitle(rows, onLoadMore !== undefined) : undefined} title="Subscriptions">
    {#if !rows}
        <div aria-busy="true" class="lu-saas-list lu-saas-list--loading"></div>
    {:else}
        <div class="lu-saas-toolbar">
            <input
                aria-label="Search subscriptions"
                class="lu-saas-input"
                oninput={(event) => (view = { ...view, search: event.currentTarget.value })}
                placeholder="Search"
                type="search"
                value={view.search}
            />
            <select
                aria-label="Filter by state"
                class="lu-saas-select"
                onchange={(event) => (view = { ...view, state: event.currentTarget.value })}
                value={view.state}
            >
                {#each states as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                {/each}
            </select>
        </div>

        {#if visible.length === 0}
            <Empty title={rows.length === 0 ? "No subscriptions yet" : "Nothing matches that filter"} />
        {:else}
            <table class="lu-saas-table">
                <thead>
                    <tr>
                        <th scope="col">Organization</th>
                        <th scope="col">Plan</th>
                        <th scope="col">State</th>
                        <th scope="col">Seats</th>
                        <th scope="col">Renewal</th>
                    </tr>
                </thead>
                <tbody>
                    {#each visible as subscription (subscription.key)}
                        <tr>
                            <td>{subscription.organization}<code class="lu-saas-row__slug">{subscription.id}</code></td>
                            <td>{subscription.plan}</td>
                            <td>{planLabel(subscription.state)}</td>
                            <td>{subscription.quantity}</td>
                            <td>{subscription.renewal}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}

        {#if onLoadMore}
            <button class="lu-saas-button lu-saas-button--quiet" onclick={onLoadMore} type="button">Load more</button>
        {/if}
    {/if}
</Card>

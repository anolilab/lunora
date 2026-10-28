<script lang="ts">
    import type { AdminSubscriptionRow, OrganizationRow, Plan, SubscriptionsView } from "../core";
    import { DEFAULT_SUBSCRIPTIONS_VIEW, planLabel, selectSubscriptions, subscriptionStateOptions, subscriptionTotals } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";

    interface Props {
        /** The organisation list, for names. Subscriptions render with ids until it arrives. */
        organizations: ReadonlyArray<OrganizationRow> | undefined;
        plans: ReadonlyArray<Plan>;
        /** `undefined` while the query is in flight. */
        rows: ReadonlyArray<AdminSubscriptionRow> | undefined;
    }

    const { organizations, plans, rows }: Props = $props();

    let view = $state<SubscriptionsView>({ ...DEFAULT_SUBSCRIPTIONS_VIEW });

    const totals = $derived(rows ? subscriptionTotals(rows) : { pastDue: 0, paying: 0 });
    const visible = $derived(rows ? selectSubscriptions(rows, organizations ?? [], plans, view) : []);
    const states = $derived(rows ? subscriptionStateOptions(rows) : []);
</script>

<Card subtitle={rows ? `${totals.paying} paying · ${totals.pastDue} past due` : undefined} title="Subscriptions">
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
                    {#each visible as subscription (subscription.id)}
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
    {/if}
</Card>

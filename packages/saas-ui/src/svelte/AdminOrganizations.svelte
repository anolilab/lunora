<script lang="ts">
    import type { AdminView, OrganizationRow, OrganizationTotals, Plan } from "../core";
    import { ORGANIZATION_SEARCH_MAX, planLabel, planOptions, relativeTime } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";

    interface Props {
        now: number;
        /**
         * Fetch the next page — the paginated query's `loadMore` over `saas.listOrganizations`.
         * Pass it only while more pages remain.
         */
        onLoadMore?: () => void;
        /**
         * The admin changed the search or a filter. The list is filtered on the server, so
         * the route owns the view and turns it into the query's arguments with
         * `toOrganizationFilter` — debounce the search there, or every keystroke restarts
         * the list at its first page.
         */
        onViewChange: (view: AdminView) => void;
        /** The plan catalog, for the plan filter — every plan, not only those on loaded pages. */
        plans: ReadonlyArray<Pick<Plan, "id" | "name">>;
        /** The pages loaded so far. `undefined` while the first page is in flight. */
        rows: ReadonlyArray<OrganizationRow> | undefined;
        /** IANA zone an older update's date is shown in — the viewer's. UTC when omitted. */
        timeZone?: string;
        /** `saas.organizationTotals` over the same filter. The header waits for it. */
        totals: OrganizationTotals | undefined;
        view: AdminView;
    }

    const { now, onLoadMore, onViewChange, plans, rows, timeZone, totals, view }: Props = $props();

    const options = $derived(planOptions(plans));
</script>

<Card subtitle={totals ? `${totals.organizations} organizations · ${totals.seats} seats` : undefined} title="Organizations">
    <div class="lu-saas-toolbar">
        <input
            aria-label="Search organizations"
            class="lu-saas-input"
            maxlength={ORGANIZATION_SEARCH_MAX}
            oninput={(event) => onViewChange({ ...view, search: event.currentTarget.value })}
            placeholder="Search"
            type="search"
            value={view.search}
        />
        <select
            aria-label="Filter by plan"
            class="lu-saas-select"
            onchange={(event) => onViewChange({ ...view, plan: event.currentTarget.value })}
            value={view.plan}
        >
            {#each options as option (option.value)}
                <option value={option.value}>{option.label}</option>
            {/each}
        </select>
    </div>

    {#if !rows}
        <div aria-busy="true" class="lu-saas-list lu-saas-list--loading"></div>
    {:else if rows.length === 0}
        <Empty title="Nothing matches that filter" />
    {:else}
        <table class="lu-saas-table">
            <thead>
                <tr>
                    <th scope="col">Organization</th>
                    <th scope="col">Plan</th>
                    <th scope="col">Seats</th>
                    <th scope="col">Updated</th>
                </tr>
            </thead>
            <tbody>
                {#each rows as organization (organization._id)}
                    <tr>
                        <td>{organization.name}<code class="lu-saas-row__slug">{organization.slug}</code></td>
                        <td>{planLabel(organization.plan)}</td>
                        <td>{organization.seats}</td>
                        <td>{relativeTime(organization.updatedAt, now, timeZone)}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
    {/if}

    {#if rows && onLoadMore}
        <button class="lu-saas-button lu-saas-button--quiet" onclick={onLoadMore} type="button">Load more</button>
    {/if}
</Card>

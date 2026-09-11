<script lang="ts">
    import type { AdminView, OrganizationRow } from "../core";
    import { adminTotals, DEFAULT_ADMIN_VIEW, planLabel, planOptions, relativeTime, selectOrganizations } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";

    interface Props {
        now: number;
        rows: ReadonlyArray<OrganizationRow> | undefined;
    }

    const { now, rows }: Props = $props();

    let view = $state<AdminView>({ ...DEFAULT_ADMIN_VIEW });

    const totals = $derived(rows ? adminTotals(rows) : { organizations: 0, seats: 0 });
    const visible = $derived(rows ? selectOrganizations(rows, view) : []);
    const plans = $derived(rows ? planOptions(rows) : []);
</script>

<Card subtitle={`${totals.organizations} organizations · ${totals.seats} seats`} title="Organizations">
    {#if !rows}
        <div aria-busy="true" class="lu-saas-list lu-saas-list--loading"></div>
    {:else}
        <div class="lu-saas-toolbar">
            <input
                aria-label="Search organizations"
                class="lu-saas-input"
                oninput={(event) => (view = { ...view, search: event.currentTarget.value })}
                placeholder="Search"
                type="search"
                value={view.search}
            />
            <select
                aria-label="Filter by plan"
                class="lu-saas-select"
                onchange={(event) => (view = { ...view, plan: event.currentTarget.value })}
                value={view.plan}
            >
                {#each plans as option (option.value)}
                    <option value={option.value}>{option.label}</option>
                {/each}
            </select>
        </div>

        {#if visible.length === 0}
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
                    {#each visible as organization (organization._id)}
                        <tr>
                            <td>{organization.name}<code class="lu-saas-row__slug">{organization.slug}</code></td>
                            <td>{planLabel(organization.plan)}</td>
                            <td>{organization.seats}</td>
                            <td>{relativeTime(organization.updatedAt, now)}</td>
                        </tr>
                    {/each}
                </tbody>
            </table>
        {/if}
    {/if}
</Card>

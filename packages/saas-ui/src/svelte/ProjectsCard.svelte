<script lang="ts">
    import type { ProjectRow, ProjectsView } from "../core";
    import { createProjectFormController, DEFAULT_VIEW, NAME_MAX_LENGTH, projectCounts, selectProjects } from "../core";
    import Card from "./Card.svelte";
    import Empty from "./Empty.svelte";
    import { createFormState } from "./use-form.svelte";

    interface Props {
        /** Whether the caller may create and archive. False hides the controls entirely. */
        canWrite: boolean;
        onArchive: (projectId: string) => Promise<unknown>; // secret-scanner:allow -- `projectId` is a parameter name in a function type, not a Cypress project id.
        onCreate: (name: string) => Promise<unknown>;
        rows: ReadonlyArray<ProjectRow> | undefined;
    }

    const { canWrite, onArchive, onCreate, rows }: Props = $props();

    let view = $state<ProjectsView>({ ...DEFAULT_VIEW });

    // `$props.id()` rather than a fixed string, for the same reason the React
    // port uses `useId()`: two ProjectsCards on one page would otherwise share
    // an id, and a label would point at whichever input rendered first.
    const uid = $props.id();
    const nameId = `${uid}-name`;
    const archivedId = `${uid}-archived`;

    // `onCreate` is referenced inside the closure, not passed directly: a
    // destructured prop read at the top level captures its first value, so a
    // parent that swaps the handler would keep submitting into the old one.
    const form = createFormState(
        createProjectFormController(
            async (name) => onCreate(name),
            () => form.controller.reset(),
        ),
    );

    const counts = $derived(rows ? projectCounts(rows) : { active: 0, archived: 0, total: 0 });
    const visible = $derived(rows ? selectProjects(rows, view) : []);
</script>

<Card subtitle={`${counts.active} active · ${counts.archived} archived`} title="Projects">
    {#if !rows}
        <div aria-busy="true" class="lu-saas-list lu-saas-list--loading"></div>
    {:else}
        {#if canWrite}
            <form
                class="lu-saas-newproject"
                onsubmit={(event) => {
                    event.preventDefault();
                    void form.controller.submit();
                }}
            >
                <label class="lu-saas-label" for={nameId}>
                    New project
                    <input
                        aria-describedby={(form.state.errors.name ?? form.state.formError) ? `${nameId}-error` : undefined}
                        aria-invalid={form.state.errors.name === undefined ? undefined : true}
                        class="lu-saas-input"
                        disabled={form.state.status === "busy"}
                        id={nameId}
                        maxlength={NAME_MAX_LENGTH}
                        oninput={(event) => form.controller.setValue("name", event.currentTarget.value)}
                        placeholder="Website redesign"
                        value={form.state.values.name}
                    />
                </label>
                <button class="lu-saas-button" disabled={form.state.status === "busy"} type="submit">
                    {form.state.status === "busy" ? "Creating…" : "Create"}
                </button>
                {#if form.state.errors.name ?? form.state.formError}
                    <p class="lu-saas-error" id={`${nameId}-error`} role="alert">{form.state.errors.name ?? form.state.formError}</p>
                {/if}
            </form>
        {/if}

        <div class="lu-saas-toolbar">
            <input
                aria-label="Search projects"
                class="lu-saas-input"
                oninput={(event) => (view = { ...view, search: event.currentTarget.value })}
                placeholder="Search"
                type="search"
                value={view.search}
            />
            <select
                aria-label="Sort projects"
                class="lu-saas-select"
                onchange={(event) => (view = { ...view, sort: event.currentTarget.value as ProjectsView["sort"] })}
                value={view.sort}
            >
                <option value="newest">Newest</option>
                <option value="oldest">Oldest</option>
                <option value="name">Name</option>
            </select>
            <label class="lu-saas-checkbox" for={archivedId}>
                <input
                    checked={view.includeArchived}
                    id={archivedId}
                    onchange={(event) => (view = { ...view, includeArchived: event.currentTarget.checked })}
                    type="checkbox"
                />
                Show archived
            </label>
        </div>

        {#if visible.length === 0}
            <Empty title={counts.total === 0 ? "No projects yet" : "Nothing matches that search"} />
        {:else}
            <ul class="lu-saas-list">
                {#each visible as project (project._id)}
                    <li class={project.archivedAt ? "lu-saas-row lu-saas-row--archived" : "lu-saas-row"}>
                        <span class="lu-saas-row__name">{project.name}</span>
                        <code class="lu-saas-row__slug">{project.slug}</code>
                        {#if canWrite && !project.archivedAt}
                            <button
                                class="lu-saas-button lu-saas-button--quiet"
                                onclick={() => {
                                    void onArchive(project._id);
                                }}
                                type="button">Archive</button
                            >
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    {/if}
</Card>

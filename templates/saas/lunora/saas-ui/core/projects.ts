/**
 * The project list's view model: search, sort and the archived filter.
 *
 * All of it is client-side on purpose. The list arrives as one live query over
 * a single tenant's shard, so it is already scoped and already small — pushing
 * a search term to the server would trade an instant local filter for a round
 * trip and a second subscription.
 *
 * When a tenant's list outgrows that, the fix is `.paginate()` in the query and
 * a cursor here, not a `LIKE` — see the `lunora-performance-audit` skill.
 */
import type { ProjectRow } from "./types";

type ProjectSort = "name" | "newest" | "oldest";

interface ProjectsView {
    /** Include archived projects. Default false — archiving is meant to hide. */
    includeArchived: boolean;
    /** Free-text match on name or slug; case- and whitespace-insensitive. */
    search: string;
    sort: ProjectSort;
}

const DEFAULT_VIEW: ProjectsView = { includeArchived: false, search: "", sort: "newest" };

const matches = (project: ProjectRow, needle: string): boolean =>
    needle === "" || project.name.toLowerCase().includes(needle) || project.slug.toLowerCase().includes(needle);

const COMPARATORS: Record<ProjectSort, (a: ProjectRow, b: ProjectRow) => number> = {
    name: (a, b) => a.name.localeCompare(b.name),
    newest: (a, b) => b._creationTime - a._creationTime,
    oldest: (a, b) => a._creationTime - b._creationTime,
};

/**
 * Apply a view to the rows. `filter` then `toSorted` — never `sort`, because the
 * input is the live query's own array and reordering it in place would reorder
 * what every other subscriber to that query is holding.
 */
const selectProjects = (rows: ReadonlyArray<ProjectRow>, view: ProjectsView = DEFAULT_VIEW): ReadonlyArray<ProjectRow> => {
    const needle = view.search.trim().toLowerCase();

    return rows.filter((project) => (view.includeArchived || !project.archivedAt) && matches(project, needle)).toSorted(COMPARATORS[view.sort]);
};

/** Counts for the list header, taken from the unfiltered rows. */
const projectCounts = (rows: ReadonlyArray<ProjectRow>): { active: number; archived: number; total: number } => {
    const archived = rows.filter((project) => project.archivedAt !== undefined).length;

    return { active: rows.length - archived, archived, total: rows.length };
};

export type { ProjectSort, ProjectsView };
export { DEFAULT_VIEW, projectCounts, selectProjects };

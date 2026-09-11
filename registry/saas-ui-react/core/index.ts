export type { ActivityEntry, ActivityGroup } from "./activity";
export { describeAction, describeActivity, groupActivityByDay } from "./activity";

/**
 * Framework-agnostic core barrel. Every port (React, Svelte, and the four that
 * follow) imports from here — the only place kit logic lives.
 *
 * Nothing in this directory imports a framework. That is not a style rule: it
 * is the property that makes the fifth port cost a day instead of a week, and
 * `vitest.config.ts` enforces it by compiling `core/` with no plugin at all.
 */
export type { AdminView, OrganizationSort } from "./admin-organizations";
export { adminTotals, DEFAULT_ADMIN_VIEW, planOptions, selectOrganizations } from "./admin-organizations";
export type { FieldSpec, FormController, FormOptions, FormState } from "./create-form-controller";
export { createFormController } from "./create-form-controller";
export { dayKey, initials, planLabel, relativeTime } from "./format";
export { errorCode, mapError, MESSAGES } from "./map-error";
export type { StatTile } from "./overview";
export { deriveOverviewStats, isFirstRun } from "./overview";
export { createProjectFormController, NAME_MAX_LENGTH, validateName } from "./project-form";
export type { ProjectSort, ProjectsView } from "./projects";
export { DEFAULT_VIEW, projectCounts, selectProjects } from "./projects";
export type { Store } from "./store";
export { createStore } from "./store";
export type { ActivityRow, FlowStatus, OrganizationRow, OverviewPayload, ProjectRow } from "./types";

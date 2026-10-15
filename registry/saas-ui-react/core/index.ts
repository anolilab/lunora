/**
 * Framework-agnostic core barrel. Every port (React, Svelte, and the four that
 * follow) imports from here — the only place kit logic lives.
 *
 * Nothing in this directory imports a framework. That is not a style rule: it
 * is the property that makes the fifth port cost a day instead of a week, and
 * a `no-restricted-imports` override in `eslint.config.js` enforces it.
 */
export type { ActivityEntry, ActivityGroup } from "./activity";
export { groupActivityByDay } from "./activity";
export type { AdminView, OrganizationSort } from "./admin-organizations";
export { adminTotals, DEFAULT_ADMIN_VIEW, planOptions, selectOrganizations } from "./admin-organizations";
export type { Plan, PricingRow, SeatUsage } from "./billing";
export { currentPlan, formatMoney, isEntitled, notEntitledLabel, pricingRows, seatAlert, seatSummary, seatUsage, subscriptionNotice } from "./billing";
export type { FieldSpec, FormController, FormOptions, FormState } from "./create-form-controller";
export { createFormController } from "./create-form-controller";
export { dayKey, initials, planLabel, relativeTime } from "./format";
export { mapError } from "./map-error";
export type { StatTile } from "./overview";
export { deriveOverviewStats, isFirstRun } from "./overview";
export type { PresenceMemberLike, Roster, RosterEntry } from "./presence";
export { presenceRoster, presenceSummary } from "./presence";
export { createProjectFormController, NAME_MAX_LENGTH } from "./project-form";
export type { ProjectSort, ProjectsView } from "./projects";
export { DEFAULT_VIEW, projectCounts, selectProjects } from "./projects";
export type { Store } from "./store";
export { createStore } from "./store";
export type { ActivityRow, FlowStatus, OrganizationRow, OverviewPayload, ProjectRow, SubscriptionLike } from "./types";

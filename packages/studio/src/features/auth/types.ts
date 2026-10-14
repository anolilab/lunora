/**
 * A single auth-admin row as returned by the org/member/team/role/invitation
 * list endpoints — an opaque bag of columns the panels read by key (`id`,
 * `name`, `role`, …) via `formatCell`. Kept here rather than in a leaf dialog /
 * detail module so the panel, the detail view, and the dialogs can all share one
 * neutral definition.
 */
export type Row = Record<string, unknown>;

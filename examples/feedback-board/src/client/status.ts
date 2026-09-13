import type { Doc as Document_ } from "../../lunora/_generated/dataModel.js";

export type Status = Document_<"feedback">["status"];

export const STATUSES = ["open", "under-review", "planned", "in-progress", "completed", "closed"] as const satisfies ReadonlyArray<Status>;

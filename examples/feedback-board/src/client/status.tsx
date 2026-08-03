import type { ReactElement } from "react";

import type { Doc } from "../../lunora/_generated/dataModel.js";

export type Status = Doc<"feedback">["status"];

export const STATUSES = ["open", "under-review", "planned", "in-progress", "completed", "closed"] as const satisfies readonly Status[];

export const StatusBadge = ({ status }: { status: Status }): ReactElement => <span className={`badge badge-${status}`}>{status.replace("-", " ")}</span>;

import type { ReactElement } from "react";

import type { Status } from "./status.js";

/** The coloured pill for one feedback status. */
export const StatusBadge = ({ status }: { status: Status }): ReactElement => <span className={`badge badge-${status}`}>{status.replace("-", " ")}</span>;

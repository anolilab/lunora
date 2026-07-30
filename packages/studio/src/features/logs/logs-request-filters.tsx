import type { ReactElement } from "react";

import { Input } from "../../components/ui/input";
import { useT } from "../../i18n/i18n-context";

/**
 * Filters for the request view: path prefix, table, user, and outcome.
 *
 * Its own component for the same reason as the error filters — a closed set of
 * controls that only this view renders.
 */
const LogsRequestFilters = ({
    onOutcomeChange,
    onPathChange,
    onTableChange,
    onUserChange,
    outcomeFilter,
    pathPrefix,
    tableFilter,
    userIdFilter,
}: {
    readonly onOutcomeChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
    readonly onPathChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly onTableChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly onUserChange: (event: React.ChangeEvent<HTMLInputElement>) => void;
    readonly outcomeFilter: string;
    readonly pathPrefix: string;
    readonly tableFilter: string;
    readonly userIdFilter: string;
}): ReactElement => {
    const t = useT();

    return (
        <div className="flex flex-wrap items-center gap-2">
            <Input
                aria-label={t("Function path")}
                className="h-8 w-44"
                data-testid="lg-req-path"
                onChange={onPathChange}
                placeholder={t("file:function")}
                value={pathPrefix}
            />
            <Input
                aria-label={t("User id")}
                className="h-8 w-32"
                data-testid="lg-req-user"
                onChange={onUserChange}
                placeholder={t("userId")}
                value={userIdFilter}
            />
            <Input
                aria-label={t("Table touched")}
                className="h-8 w-32"
                data-testid="lg-req-table"
                onChange={onTableChange}
                placeholder={t("table")}
                value={tableFilter}
            />
            <select
                aria-label={t("Outcome filter")}
                className="h-8 rounded-md border border-input bg-transparent px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 focus-visible:outline-none"
                data-testid="lg-req-outcome"
                onChange={onOutcomeChange}
                value={outcomeFilter}
            >
                <option value="all">{t("all")}</option>
                <option value="ok">{t("ok")}</option>
                <option value="error">{t("error")}</option>
            </select>
        </div>
    );
};

export { LogsRequestFilters };

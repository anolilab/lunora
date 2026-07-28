import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";
import { MigrationsPanel } from "./migrations";
import { SchemaHistoryPanel } from "./schema-history";

/**
 * The Migrations page: schema versions above, data migrations below.
 *
 * A real component rather than inline JSX in the router, so its headings can go
 * through `useT()` like every other string in the studio — `buildRouter` is a
 * plain function and cannot call hooks, which is how these two headings shipped
 * hard-coded in English.
 *
 * The two sections stay separate on purpose. Schema is applied at runtime from
 * `defineSchema`; `defineMigration` is hand-written data movement. Merging them
 * into one timeline would imply a causal link the data does not carry.
 */
export const MigrationsRoutePanel = ({ initialShardKey }: { readonly initialShardKey?: string }): ReactElement => {
    const t = useT();

    return (
        <div className="flex min-h-0 flex-1 flex-col gap-8">
            <div className="flex min-h-[24rem] flex-col gap-2">
                <h2 className="text-sm font-medium">{t("Schema versions")}</h2>
                <SchemaHistoryPanel shardKey={initialShardKey} />
            </div>
            <div className="flex flex-col gap-2">
                <h2 className="text-sm font-medium">{t("Data migrations")}</h2>
                <MigrationsPanel initialShardKey={initialShardKey} />
            </div>
        </div>
    );
};

import type { ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import { composeCreateIndex } from "./compose-index-sql";

interface ApplyIndexButtonProps {
    /** Fields covered by the suggested index (at minimum the FK column). */
    readonly fields: ReadonlyArray<string>;
    /** Suggested index name from the finding's `suggestedIndex.name`. */
    readonly indexName: string;
    /** The table missing the index. */
    readonly table: string;
    /** Stable id for data-testid attributes. */
    readonly testId: string;
}

/**
 * Confirm-before-apply button for a missing-index advisory finding.
 *
 * Composes a `CREATE INDEX IF NOT EXISTS` SQL statement from the finding's
 * `table` / `indexName` / `fields` and, after the operator confirms, copies it
 * to the clipboard. The operator can then paste it into the SQL editor or
 * their migration tooling.
 *
 * The copy-to-clipboard approach is deliberately chosen because the studio's
 * `runSql` admin RPC is read-only (it rejects DDL by design to prevent
 * uncontrolled schema changes that would bypass the schema-aware writer). The
 * confirm step guards against accidental clicks and surfaces the composed SQL
 * as confirmation feedback.
 */
const ApplyIndexButton = ({ fields, indexName, table, testId }: ApplyIndexButtonProps): ReactElement => {
    const t = useT();
    const [applied, setApplied] = useState(false);

    const onConfirm = (): void => {
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard; guarded by the "navigator" in globalThis check
        const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

        if (clipboard === undefined) {
            return;
        }

        const sql = composeCreateIndex(table, indexName, fields);

        fireAndForget(clipboard.writeText(sql));
        setApplied(true);
    };

    if (applied) {
        return (
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-applied`}>
                {t("CREATE INDEX SQL copied to clipboard.")}
            </span>
        );
    }

    return (
        <ConfirmButton confirmLabel={t("Apply?")} onConfirm={onConfirm} testId={testId}>
            {t("Apply index on {table}", { table })}
        </ConfirmButton>
    );
};

export { ApplyIndexButton };
export type { ApplyIndexButtonProps };

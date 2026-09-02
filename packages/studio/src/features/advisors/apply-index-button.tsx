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
 * Confirm-before-copy button for a missing-index advisory finding.
 *
 * Composes a `CREATE INDEX IF NOT EXISTS` statement from the finding's
 * `table` / `indexName` / `fields` and, after the operator confirms, copies it
 * to the clipboard. The operator can then paste it into the SQL editor or
 * their migration tooling.
 *
 * It COPIES; it does not apply. The label says so, because the studio's `runSql`
 * admin RPC is read-only (it rejects DDL by design, so a schema change can't
 * bypass the schema-aware writer) and nothing here can run the statement. The
 * confirm step guards against accidental clicks.
 *
 * Both ways a copy can fail end at the same place — the statement rendered for
 * manual selection. A studio served over a LAN IP is not a secure context, so
 * `navigator.clipboard` is `undefined` there; and even where it exists the write
 * can be denied. Neither may report a copy that did not happen.
 */
const ApplyIndexButton = ({ fields, indexName, table, testId }: ApplyIndexButtonProps): ReactElement => {
    const t = useT();
    const [outcome, setOutcome] = useState<null | { copied: boolean; sql: string }>(null);

    const onConfirm = (): void => {
        const sql = composeCreateIndex(table, indexName, fields);
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard; guarded by the "navigator" in globalThis check
        const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

        if (clipboard === undefined) {
            setOutcome({ copied: false, sql });

            return;
        }

        fireAndForget(
            clipboard.writeText(sql).then((): boolean => {
                setOutcome({ copied: true, sql });

                return true;
            }),
            () => {
                setOutcome({ copied: false, sql });
            },
        );
    };

    if (outcome !== null) {
        return outcome.copied ? (
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-applied`}>
                {t("CREATE INDEX SQL copied to clipboard.")}
            </span>
        ) : (
            <span className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid={`${testId}-manual`}>
                {t("Could not reach the clipboard — copy this statement:")}
                <code className="font-mono break-all select-all">{outcome.sql}</code>
            </span>
        );
    }

    return (
        <ConfirmButton confirmLabel={t("Copy?")} onConfirm={onConfirm} testId={testId}>
            {t("Copy index SQL for {table}", { table })}
        </ConfirmButton>
    );
};

export { ApplyIndexButton };
export type { ApplyIndexButtonProps };

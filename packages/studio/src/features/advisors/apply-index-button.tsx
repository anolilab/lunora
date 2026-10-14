import type { ReactElement } from "react";
import { useState } from "react";

import { ConfirmButton } from "../../components/confirm-button";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import { composeIndexDeclaration } from "./compose-index-declaration";

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
 * Composes the `.index("name", [fields])` declaration from the finding's
 * `indexName` / `fields` and, after the operator confirms, copies it to the
 * clipboard. The operator appends it to the table in `lunora/schema.ts` — what
 * the lint's own remediation names, and the only mechanism the migration system
 * tracks. Raw `CREATE INDEX … ON "posts" ("authorId")` DDL is NOT what to hand
 * over: a shard table is `(id, _creationTime, __doc__)`, so that statement fails
 * with `no such column: authorId` wherever it is pasted.
 *
 * It COPIES; it does not apply. The label says so — the studio's `runSql` admin
 * RPC is read-only and nothing here writes the project's source. The confirm
 * step guards against accidental clicks.
 *
 * Both ways a copy can fail end at the same place — the declaration rendered for
 * manual selection. A studio served over a LAN IP is not a secure context, so
 * `navigator.clipboard` is `undefined` there; and even where it exists the write
 * can be denied. Neither may report a copy that did not happen.
 */
const ApplyIndexButton = ({ fields, indexName, table, testId }: ApplyIndexButtonProps): ReactElement => {
    const t = useT();
    const [outcome, setOutcome] = useState<null | { copied: boolean; declaration: string }>(null);

    const onConfirm = (): void => {
        const declaration = composeIndexDeclaration(indexName, fields);
        // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only clipboard; guarded by the "navigator" in globalThis check
        const clipboard: Clipboard | undefined = "navigator" in globalThis ? globalThis.navigator.clipboard : undefined;

        if (clipboard === undefined) {
            setOutcome({ copied: false, declaration });

            return;
        }

        fireAndForget(
            clipboard.writeText(declaration).then((): boolean => {
                setOutcome({ copied: true, declaration });

                return true;
            }),
            () => {
                setOutcome({ copied: false, declaration });
            },
        );
    };

    if (outcome !== null) {
        return outcome.copied ? (
            <span className="text-xs text-muted-foreground" data-testid={`${testId}-applied`}>
                {t("Index declaration copied — add it to {table} in lunora/schema.ts.", { table })}
            </span>
        ) : (
            <span className="flex flex-col gap-1 text-xs text-muted-foreground" data-testid={`${testId}-manual`}>
                {t("Could not reach the clipboard — add this to {table} in lunora/schema.ts:", { table })}
                <code className="font-mono break-all select-all">{outcome.declaration}</code>
            </span>
        );
    }

    return (
        <ConfirmButton confirmLabel={t("Copy?")} onConfirm={onConfirm} testId={testId}>
            {t("Copy index declaration for {table}", { table })}
        </ConfirmButton>
    );
};

export { ApplyIndexButton };
export type { ApplyIndexButtonProps };

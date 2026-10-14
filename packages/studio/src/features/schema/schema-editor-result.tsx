import type { ReactElement } from "react";

import { Button } from "../../components/ui/button";
import { useT } from "../../i18n/i18n-context";
import type { SchemaEditResult } from "../../lib/schema-edit";

/**
 * What happened to the last schema edit: a failure message, the
 * needs-a-migration verdict with its jump to the Migrations page, or codegen's
 * diagnostics on an otherwise-applied edit.
 *
 * Its own component because it is the one part of the overlay that renders the
 * OUTCOME rather than collecting input — the forms above it all read and write
 * draft state, this reads only `result`. Rendering nothing when there is no
 * result keeps the caller free of a wrapper condition.
 */
const SchemaEditorResult = ({
    onOpenMigrations,
    result,
}: {
    readonly onOpenMigrations: () => void;
    readonly result: null | SchemaEditResult;
}): ReactElement => {
    const t = useT();

    if (result === null) {
        return <></>;
    }

    if (result.kind === "error") {
        return (
            <p className="mt-3 text-sm text-destructive" data-testid="sc-editor-error" role="alert">
                {result.message}
            </p>
        );
    }

    if (result.kind === "needs-migration") {
        return (
            <div className="mt-3 flex flex-col gap-2" data-testid="sc-editor-needs-migration">
                <p className="text-sm text-warning" role="alert">
                    {result.message === ""
                        ? t("This edit changes stored data and must go through a migration. Review the migration before applying.")
                        : result.message}
                </p>
                <Button className="self-start" data-testid="sc-editor-open-migrations" onClick={onOpenMigrations} size="xs" type="button" variant="outline">
                    {t("Open Migrations")}
                </Button>
            </div>
        );
    }

    if (result.diagnostics.length === 0) {
        return <></>;
    }

    return (
        <div className="mt-3 flex flex-col gap-1" data-testid="sc-editor-diagnostics">
            <p className="text-sm text-destructive" role="alert">
                {t("Codegen reported diagnostics:")}
            </p>
            <ul className="flex flex-col gap-0.5">
                {result.diagnostics.map((diagnostic) => (
                    <li className="font-mono text-[11px] text-destructive" key={diagnostic}>
                        {diagnostic}
                    </li>
                ))}
            </ul>
        </div>
    );
};

export default SchemaEditorResult;

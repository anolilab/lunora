import { useNavigate } from "@tanstack/react-router";
import type { ChangeEvent, ReactElement } from "react";
import { useState } from "react";

import { Button } from "../../components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../../components/ui/card";
import { Input } from "../../components/ui/input";
import { Label } from "../../components/ui/label";
import { useT } from "../../i18n/i18n-context";
import { fireAndForget } from "../../lib/internal";
import type { AdditiveEdit, SchemaEditResult, SchemaEditTable } from "../../lib/schema-edit";
import { applyEdit } from "../../lib/schema-edit";
import type { Mode } from "./schema-editor-mode-bar";
import { SchemaEditorModeBar } from "./schema-editor-mode-bar";
import SchemaEditorResult from "./schema-editor-result";

/** Validator palette for an added optional column. Each maps to a `v.*` call. */
const COLUMN_TYPES: ReadonlyArray<{ label: string; validator: string }> = [
    { label: "string", validator: "v.string()" },
    { label: "number", validator: "v.number()" },
    { label: "boolean", validator: "v.boolean()" },
    // `v.bigint()`, not `v.int64()`: `int64` is neither exported by
    // `@lunora/values` nor on the server's validator allow-list, so every
    // "bigint" column the palette offered answered `400 invalid-validator`.
    { label: "bigint", validator: "v.bigint()" },
    { label: "bytes", validator: "v.bytes()" },
    { label: "any", validator: "v.any()" },
];

/** Default validator for a new column (the first palette entry). */
const DEFAULT_VALIDATOR = "v.string()";

/** Split a comma-separated field list into trimmed, non-empty field names. */
const splitFields = (raw: string): string[] =>
    raw
        .split(",")
        .map((field) => field.trim())
        .filter((field) => field !== "");

interface SchemaEditorOverlayProps {
    /** Called with the new table list after a successful additive edit. */
    readonly onApplied: (tables: ReadonlyArray<SchemaEditTable>) => void;
    /** Existing shard table names, offered as the column/index target. */
    readonly tableNames: ReadonlyArray<string>;
}

/**
 * Local-dev schema authoring overlay (plan 024 Item 4). Renders add-table /
 * add-column / add-index forms over the read-only diagram and applies each via
 * the dev host's local schema-edit endpoint — never the worker admin RPC. On
 * success it surfaces codegen diagnostics and hands the new table list back so
 * the viewer re-probes. A destructive edit is never issued here; the endpoint
 * routes those to the migration handoff (Item 5), which this overlay surfaces.
 *
 * Mounted only when `SchemaViewer` receives `schemaEditable` (set by the
 * loopback dev hosts), so it is absent from a deployed/read-only studio.
 */
export const SchemaEditorOverlay = ({ onApplied, tableNames }: SchemaEditorOverlayProps): ReactElement => {
    const t = useT();
    const navigate = useNavigate();

    const [mode, setMode] = useState<Mode>(null);
    const [busy, setBusy] = useState<boolean>(false);
    const [result, setResult] = useState<SchemaEditResult | null>(null);

    // Form fields, shared across the three forms (only the relevant ones are shown).
    const [tableName, setTableName] = useState<string>("");
    const [columnName, setColumnName] = useState<string>("");
    const [validator, setValidator] = useState<string>(DEFAULT_VALIDATOR);
    const [targetTable, setTargetTable] = useState<string>(tableNames[0] ?? "");
    const [indexName, setIndexName] = useState<string>("");
    const [indexFields, setIndexFields] = useState<string>("");
    const [unique, setUnique] = useState<boolean>(false);

    const reset = (): void => {
        setMode(null);
        setTableName("");
        setColumnName("");
        setIndexName("");
        setIndexFields("");
        setUnique(false);
    };

    const submit = async (edit: AdditiveEdit): Promise<void> => {
        setBusy(true);
        setResult(null);

        try {
            const outcome = await applyEdit(edit);

            setResult(outcome);

            if (outcome.kind === "ok") {
                onApplied(outcome.tables);
                reset();
            }
        } catch (error) {
            setResult({ kind: "error", message: error instanceof Error ? error.message : String(error) });
        }

        setBusy(false);
    };

    const onSubmitTable = (): void => {
        fireAndForget(submit({ kind: "addTable", table: tableName.trim() }));
    };

    const onSubmitColumn = (): void => {
        fireAndForget(submit({ column: columnName.trim(), kind: "addOptionalColumn", table: targetTable, validator }));
    };

    const onSubmitIndex = (): void => {
        fireAndForget(
            submit({
                fields: splitFields(indexFields),
                kind: "addIndex",
                name: indexName.trim(),
                table: targetTable,
                unique,
            }),
        );
    };

    const openTable = (): void => {
        setResult(null);
        setMode("addTable");
    };
    const openColumn = (): void => {
        setResult(null);
        setMode("addColumn");
    };
    const openIndex = (): void => {
        setResult(null);
        setMode("addIndex");
    };
    const openDestructive = (): void => {
        // A rename / drop / type-change / required edit changes the persisted
        // SQLite shape, so it is NEVER POSTed to the additive endpoint. We
        // surface the migration handoff locally (plan 024 Item 5) — same UI the
        // host's `needsMigration` response drives — and route to Migrations.
        setMode("destructive");
        setResult({
            kind: "needs-migration",
            message: t("This edit changes stored data and must go through a migration. Review the migration before applying."),
        });
    };

    const onTableNameChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setTableName(event.target.value);
    };
    const onColumnNameChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setColumnName(event.target.value);
    };
    const onValidatorChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setValidator(event.target.value);
    };
    const onTargetTableChange = (event: ChangeEvent<HTMLSelectElement>): void => {
        setTargetTable(event.target.value);
    };
    const onIndexNameChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setIndexName(event.target.value);
    };
    const onIndexFieldsChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setIndexFields(event.target.value);
    };
    const onUniqueChange = (event: ChangeEvent<HTMLInputElement>): void => {
        setUnique(event.target.checked);
    };
    const onOpenMigrations = (): void => {
        fireAndForget(navigate({ to: "/migrations" }));
    };

    return (
        <Card data-testid="sc-editor" size="sm">
            <CardHeader>
                <CardTitle>{t("Edit schema")}</CardTitle>
                <CardDescription>{t("Adds a table, column, or index to lunora/schema.ts and reruns codegen.")}</CardDescription>
            </CardHeader>
            <CardContent>
                <SchemaEditorModeBar
                    hasTables={tableNames.length > 0}
                    mode={mode}
                    onAddColumn={openColumn}
                    onAddIndex={openIndex}
                    onAddTable={openTable}
                    onDestructive={openDestructive}
                />

                {mode === "addTable" && (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="sc-editor-table-form">
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-table-name">{t("Table name")}</Label>
                            <Input data-testid="sc-editor-table-name" id="sc-editor-table-name" onChange={onTableNameChange} value={tableName} />
                        </div>
                        <Button data-testid="sc-editor-table-apply" disabled={busy || tableName.trim() === ""} onClick={onSubmitTable} size="xs" type="button">
                            {busy ? t("Applying…") : t("Apply")}
                        </Button>
                        <Button onClick={reset} size="xs" type="button" variant="ghost">
                            {t("Cancel")}
                        </Button>
                    </div>
                )}

                {mode === "addColumn" && (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="sc-editor-column-form">
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-column-table">{t("Table name")}</Label>
                            {/* react-doctor-disable-next-line react-doctor/control-has-associated-label -- labelled by the `<Label htmlFor="sc-editor-column-table">` directly above; the rule only recognises a nested or aria label */}
                            <select
                                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                                data-testid="sc-editor-column-table"
                                id="sc-editor-column-table"
                                onChange={onTargetTableChange}
                                value={targetTable}
                            >
                                {tableNames.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-column-name">{t("Column name")}</Label>
                            <Input data-testid="sc-editor-column-name" id="sc-editor-column-name" onChange={onColumnNameChange} value={columnName} />
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-column-type">{t("Column type")}</Label>
                            {/* react-doctor-disable-next-line react-doctor/control-has-associated-label -- labelled by the `<Label htmlFor="sc-editor-column-type">` directly above; the rule only recognises a nested or aria label */}
                            <select
                                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                                data-testid="sc-editor-column-type"
                                id="sc-editor-column-type"
                                onChange={onValidatorChange}
                                value={validator}
                            >
                                {COLUMN_TYPES.map((type) => (
                                    <option key={type.validator} value={type.validator}>
                                        {type.label}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <span className="text-[11px] text-muted-foreground">{t("Optional")}</span>
                        <Button
                            data-testid="sc-editor-column-apply"
                            disabled={busy || columnName.trim() === "" || targetTable === ""}
                            onClick={onSubmitColumn}
                            size="xs"
                            type="button"
                        >
                            {busy ? t("Applying…") : t("Apply")}
                        </Button>
                        <Button onClick={reset} size="xs" type="button" variant="ghost">
                            {t("Cancel")}
                        </Button>
                    </div>
                )}

                {mode === "addIndex" && (
                    <div className="mt-3 flex flex-wrap items-end gap-2" data-testid="sc-editor-index-form">
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-index-table">{t("Table name")}</Label>
                            {/* react-doctor-disable-next-line react-doctor/control-has-associated-label -- labelled by the `<Label htmlFor="sc-editor-index-table">` directly above; the rule only recognises a nested or aria label */}
                            <select
                                className="h-8 rounded-md border border-input bg-transparent px-2 text-xs"
                                data-testid="sc-editor-index-table"
                                id="sc-editor-index-table"
                                onChange={onTargetTableChange}
                                value={targetTable}
                            >
                                {tableNames.map((name) => (
                                    <option key={name} value={name}>
                                        {name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-index-name">{t("Index name")}</Label>
                            <Input data-testid="sc-editor-index-name" id="sc-editor-index-name" onChange={onIndexNameChange} value={indexName} />
                        </div>
                        <div className="flex flex-col gap-1 text-xs">
                            <Label htmlFor="sc-editor-index-fields">{t("Index fields (comma-separated)")}</Label>
                            <Input data-testid="sc-editor-index-fields" id="sc-editor-index-fields" onChange={onIndexFieldsChange} value={indexFields} />
                        </div>
                        <Label className="flex items-center gap-1 text-xs" htmlFor="sc-editor-index-unique">
                            <input
                                checked={unique}
                                data-testid="sc-editor-index-unique"
                                id="sc-editor-index-unique"
                                onChange={onUniqueChange}
                                type="checkbox"
                            />
                            <span className="text-muted-foreground">{t("Unique")}</span>
                        </Label>
                        <Button
                            data-testid="sc-editor-index-apply"
                            disabled={busy || indexName.trim() === "" || indexFields.trim() === ""}
                            onClick={onSubmitIndex}
                            size="xs"
                            type="button"
                        >
                            {busy ? t("Applying…") : t("Apply")}
                        </Button>
                        <Button onClick={reset} size="xs" type="button" variant="ghost">
                            {t("Cancel")}
                        </Button>
                    </div>
                )}

                <SchemaEditorResult onOpenMigrations={onOpenMigrations} result={result} />
            </CardContent>
        </Card>
    );
};

export type { SchemaEditorOverlayProps };

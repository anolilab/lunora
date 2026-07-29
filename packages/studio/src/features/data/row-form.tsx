import type { ReactElement } from "react";
import { useState } from "react";

import { Checkbox } from "../../components/ui/checkbox";
import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";

/** Shared control-button class (mirrors the data-browser toolbar). */
const CONTROL_BTN =
    "inline-flex items-center gap-1 rounded-md border border-border px-2.5 py-1 text-xs font-medium text-foreground outline-none transition-colors hover:bg-accent focus-visible:bg-accent aria-pressed:bg-accent aria-pressed:text-accent-foreground disabled:pointer-events-none disabled:opacity-50";

/** Shared text-ish input class. */
const FIELD_INPUT = "w-full rounded-md border border-border bg-background px-2 py-1 font-mono text-xs outline-none focus-visible:border-ring";

/** Numeric columns whose name reads as an epoch-ms timestamp get a date picker. */
const TIMESTAMP_RE = /(?:_creationtime|(?:^|[a-z])(?:time|at))$/iu;

/** The widget a field renders as, inferred from its current value + column name. */
type FieldKind = "boolean" | "date" | "json" | "number" | "text";

/**
 * Infer the input widget for a field from its current value (and, for numbers, its
 * column name): booleans toggle, timestamp-named numbers get a date picker, other
 * numbers a number input, objects/arrays a JSON sub-editor, everything else text.
 */
const inferKind = (column: string, value: unknown): FieldKind => {
    if (typeof value === "boolean") {
        return "boolean";
    }

    if (typeof value === "number") {
        return TIMESTAMP_RE.test(column) ? "date" : "number";
    }

    if (value !== null && typeof value === "object") {
        return "json";
    }

    return "text";
};

/** Parse `documentText` to a field object, or `null` when it isn't a JSON object (force raw mode). */
const parseDocument = (documentText: string): Record<string, unknown> | null => {
    try {
        const value = JSON.parse(documentText) as unknown;

        return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
    } catch {
        return null;
    }
};

/** Format an epoch-ms value as a `datetime-local` input string in the viewer's local time. */
const toLocalDateTime = (ms: number): string => {
    const date = new Date(ms);
    const pad = (n: number): string => String(n).padStart(2, "0");

    return `${date.getFullYear().toString()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

interface FieldProps {
    readonly column: string;
    readonly onChange: (column: string, value: unknown) => void;
    readonly value: unknown;
}

/** Boolean field → a checkbox toggle. */
const BooleanField = ({ column, onChange, value }: FieldProps): ReactElement => {
    const onCheckedChange = (checked: boolean): void => {
        onChange(column, checked);
    };

    return <Checkbox aria-label={column} checked={value === true} data-testid={`db-field-${column}`} onCheckedChange={onCheckedChange} />;
};

/** Number field → a numeric input; empty/NaN leaves the value unchanged. */
const NumberField = ({ column, onChange, value }: FieldProps): ReactElement => {
    const onInput = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const next = Number(event.target.value);

        if (event.target.value !== "" && !Number.isNaN(next)) {
            onChange(column, next);
        }
    };

    return (
        <input
            aria-label={column}
            className={FIELD_INPUT}
            data-testid={`db-field-${column}`}
            onChange={onInput}
            type="number"
            value={typeof value === "number" ? value : ""}
        />
    );
};

/** Timestamp field → a `datetime-local` picker mapping to/from epoch-ms. */
const DateField = ({ column, onChange, value }: FieldProps): ReactElement => {
    const onInput = (event: React.ChangeEvent<HTMLInputElement>): void => {
        const ms = new Date(event.target.value).getTime();

        if (!Number.isNaN(ms)) {
            onChange(column, ms);
        }
    };

    return (
        <input
            aria-label={column}
            className={FIELD_INPUT}
            data-testid={`db-field-${column}`}
            onChange={onInput}
            type="datetime-local"
            value={typeof value === "number" ? toLocalDateTime(value) : ""}
        />
    );
};

/** Plain text field. */
const TextField = ({ column, onChange, value }: FieldProps): ReactElement => {
    const onInput = (event: React.ChangeEvent<HTMLInputElement>): void => {
        onChange(column, event.target.value);
    };

    return (
        <input
            aria-label={column}
            className={FIELD_INPUT}
            data-testid={`db-field-${column}`}
            onChange={onInput}
            type="text"
            value={typeof value === "string" ? value : ""}
        />
    );
};

/**
 * Object/array field → a JSON sub-editor. Holds the in-progress text locally so a
 * half-typed (temporarily invalid) value isn't lost; commits the parsed value to
 * the parent only when it's valid JSON, flagging an error otherwise.
 */
const JsonField = ({ column, onChange, value }: FieldProps): ReactElement => {
    const t = useT();
    const [text, setText] = useState<string>(() => JSON.stringify(value, null, 2));
    const [error, setError] = useState<boolean>(false);

    const onInput = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        const next = event.target.value;

        setText(next);

        try {
            onChange(column, JSON.parse(next));
            setError(false);
        } catch {
            setError(true);
        }
    };

    return (
        <div className="flex flex-col gap-1">
            <textarea
                aria-label={column}
                className={cn(FIELD_INPUT, "min-h-16", error && "border-destructive")}
                data-testid={`db-field-${column}`}
                onChange={onInput}
                value={text}
            />
            {error && (
                <span className="text-xs text-destructive" data-testid={`db-field-error-${column}`}>
                    {t("Invalid JSON")}
                </span>
            )}
        </div>
    );
};

/** One labelled field row: the column name, a foreign-key hint, and the inferred input. */
const FieldRow = ({ column, onChange, target, value }: FieldProps & { readonly target?: string }): ReactElement => {
    const kind = inferKind(column, value);

    return (
        <label className="flex flex-col gap-1 text-xs" htmlFor={`db-field-${column}`}>
            <span className="flex items-center gap-1.5 font-medium text-muted-foreground">
                <span className="font-mono">{column}</span>
                {target !== undefined && <span className="rounded bg-muted px-1 font-mono text-[10px] tracking-wide uppercase">→ {target}</span>}
            </span>
            {kind === "boolean" && <BooleanField column={column} onChange={onChange} value={value} />}
            {kind === "number" && <NumberField column={column} onChange={onChange} value={value} />}
            {kind === "date" && <DateField column={column} onChange={onChange} value={value} />}
            {kind === "json" && <JsonField column={column} onChange={onChange} value={value} />}
            {kind === "text" && <TextField column={column} onChange={onChange} value={value} />}
        </label>
    );
};

interface RowFormEditorProps {
    /** The row document as JSON text — the single source of truth, shared with the raw-JSON mode. */
    readonly documentText: string;
    readonly onCancel: () => void;
    /** Replace the whole document text (a field edit re-serializes the object). */
    readonly onDocumentTextChange: (text: string) => void;
    readonly onSave: () => void;
    /** Foreign-key map (field → target table) for the per-field hint. */
    readonly refs: Record<string, string> | undefined;
}

/**
 * Structured row editor: a type-aware form over the row's fields with a raw-JSON
 * fallback. The form parses `documentText` into fields, renders the inferred input per
 * field (text / number / boolean / date / JSON), and re-serializes on every edit —
 * so the JSON string stays the single source of truth and the save path (which
 * parses `documentText`) is unchanged. Falls back to (and offers a toggle to) the raw
 * textarea, which is also the only mode when the text isn't a JSON object.
 */
const RowFormEditor = ({ documentText, onCancel, onDocumentTextChange, onSave, refs }: RowFormEditorProps): ReactElement => {
    const t = useT();
    const fields = parseDocument(documentText);
    const [rawMode, setRawMode] = useState<boolean>(false);

    const showForm = !rawMode && fields !== null;

    const onField = (column: string, value: unknown): void => {
        onDocumentTextChange(JSON.stringify({ ...fields, [column]: value }, null, 2));
    };

    const onTextarea = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
        onDocumentTextChange(event.target.value);
    };

    const showFormMode = (): void => {
        setRawMode(false);
    };

    const showJsonMode = (): void => {
        setRawMode(true);
    };

    return (
        <div className="flex flex-col gap-2 border border-border bg-card p-3" data-testid="db-editor">
            <div className="flex items-center gap-1.5">
                <button
                    aria-pressed={showForm}
                    className={CONTROL_BTN}
                    data-testid="db-editor-form"
                    disabled={fields === null}
                    onClick={showFormMode}
                    type="button"
                >
                    {t("Form")}
                </button>
                <button aria-pressed={!showForm} className={CONTROL_BTN} data-testid="db-editor-json" onClick={showJsonMode} type="button">
                    {t("JSON")}
                </button>
            </div>

            {showForm ? (
                <div className="flex flex-col gap-3" data-testid="db-editor-fields">
                    {Object.entries(fields).map(([column, value]) => (
                        <FieldRow column={column} key={column} onChange={onField} target={refs?.[column]} value={value} />
                    ))}
                </div>
            ) : (
                <textarea
                    aria-label={t("Row document JSON")}
                    className="min-h-28 w-full rounded-md border border-border bg-background px-2 py-1.5 font-mono text-xs outline-none focus-visible:border-ring"
                    data-testid="db-editor-doc"
                    onChange={onTextarea}
                    value={documentText}
                />
            )}

            <div className="flex items-center gap-1.5">
                <button className={CONTROL_BTN} data-testid="db-editor-save" onClick={onSave} type="button">
                    {t("Save")}
                </button>
                <button className={CONTROL_BTN} data-testid="db-editor-cancel" onClick={onCancel} type="button">
                    {t("Cancel")}
                </button>
            </div>
        </div>
    );
};

export default RowFormEditor;

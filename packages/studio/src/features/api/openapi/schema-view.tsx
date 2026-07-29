import type { ReactElement } from "react";

import { useT } from "../../../i18n/i18n-context";

/**
 * A JSON-Schema-ish node as it appears in the generated OpenAPI / OpenRPC
 * documents. Lunora emits a small, predictable subset (objects, arrays, scalars,
 * `const`, `anyOf`), so this models only those fields plus the handful of
 * validation keywords the reference surfaces as badges (`format`, numeric
 * bounds). The `x-lunora-table` extension marks an id string that references a
 * table, so the schema view can surface the referenced table name.
 */
interface SchemaNode {
    anyOf?: SchemaNode[];
    const?: unknown;
    description?: string;
    enum?: unknown[];
    exclusiveMaximum?: number;
    exclusiveMinimum?: number;
    format?: string;
    items?: SchemaNode;
    maximum?: number;
    minimum?: number;
    properties?: Record<string, SchemaNode>;
    required?: string[];
    type?: string;
    "x-lunora-table"?: string;
}

/** The scalar type name implied by a literal value (used to label an enum's base type). */
const scalarOf = (value: unknown): string => {
    if (typeof value === "number") {
        return "number";
    }

    if (typeof value === "boolean") {
        return "boolean";
    }

    return "string";
};

/** The enumerated values a node constrains to — a JSON-Schema `enum`, or Lunora's `anyOf` of `const`s — else undefined. */
const enumValues = (schema: SchemaNode): undefined | unknown[] => {
    if (schema.enum !== undefined && schema.enum.length > 0) {
        return schema.enum;
    }

    if (schema.anyOf !== undefined && schema.anyOf.length > 0 && schema.anyOf.every((member) => member.const !== undefined)) {
        return schema.anyOf.map((member) => member.const);
    }

    return undefined;
};

/** Render a schema node as a short, human-readable type label (best-effort, non-recursive past one level). */
const typeLabel = (schema: SchemaNode | undefined): string => {
    if (schema === undefined) {
        return "any";
    }

    if (schema.const !== undefined) {
        return JSON.stringify(schema.const);
    }

    if (schema.enum !== undefined && schema.enum.length > 0) {
        return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
    }

    if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
        return schema.anyOf.map((member) => typeLabel(member)).join(" | ");
    }

    if (schema.type === "array") {
        return `array<${typeLabel(schema.items)}>`;
    }

    return schema.type ?? "any";
};

/** The type label shown in a field row: the base scalar for an enum (its values move to a `Value in` badge), else {@link typeLabel}. */
const fieldTypeLabel = (schema: SchemaNode): string => {
    const values = enumValues(schema);

    if (values !== undefined) {
        return schema.type ?? scalarOf(values[0]);
    }

    return typeLabel(schema);
};

/** The `Value in "a" | "b"` badge text for an enumerated node, else undefined. */
const valueInText = (schema: SchemaNode): string | undefined => {
    const values = enumValues(schema);

    return values === undefined ? undefined : values.map((value) => JSON.stringify(value)).join(" | ");
};

/** The numeric `Range` badge text (e.g. `0 ≤ value ≤ 1`), built from inclusive/exclusive bounds, else undefined. */
const rangeText = (schema: SchemaNode): string | undefined => {
    const parts: string[] = [];

    if (schema.minimum !== undefined) {
        parts.push(`${String(schema.minimum)} ≤`);
    } else if (schema.exclusiveMinimum !== undefined) {
        parts.push(`${String(schema.exclusiveMinimum)} <`);
    }

    const hasLower = parts.length > 0;

    parts.push("value");

    if (schema.maximum !== undefined) {
        parts.push(`≤ ${String(schema.maximum)}`);
    } else if (schema.exclusiveMaximum !== undefined) {
        parts.push(`< ${String(schema.exclusiveMaximum)}`);
    }

    const hasUpper = parts.length > (hasLower ? 2 : 1);

    return hasLower || hasUpper ? parts.join(" ") : undefined;
};

/** The nested object schema to drill into for a field — the object itself, or an array's object items — else undefined. */
const childObject = (schema: SchemaNode): SchemaNode | undefined => {
    if (schema.type === "object" && schema.properties !== undefined) {
        return schema;
    }

    if (schema.type === "array" && schema.items?.type === "object" && schema.items.properties !== undefined) {
        return schema.items;
    }

    return undefined;
};

/** A minimal JSON value standing in for a schema, used to seed request examples. */
const exampleForSchema = (schema: SchemaNode | undefined): unknown => {
    if (schema === undefined) {
        return null;
    }

    if (schema.const !== undefined) {
        return schema.const;
    }

    if (schema.enum !== undefined && schema.enum.length > 0) {
        return schema.enum[0];
    }

    if (schema.anyOf !== undefined && schema.anyOf.length > 0) {
        return exampleForSchema(schema.anyOf[0]);
    }

    switch (schema.type) {
        case "array": {
            return [];
        }
        case "boolean": {
            return false;
        }
        case "number": {
            return 0;
        }
        case "object": {
            const out: Record<string, unknown> = {};

            for (const [key, child] of Object.entries(schema.properties ?? {})) {
                out[key] = exampleForSchema(child);
            }

            return out;
        }
        case "string": {
            return "";
        }
        default: {
            return null;
        }
    }
};

interface BadgeProps {
    readonly label: string;
    readonly value: string;
}

/** A two-tone constraint chip — a muted label beside its mono value (Format / Range / Value in / relation). */
const Badge = ({ label, value }: BadgeProps): ReactElement => (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5 font-mono text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="text-foreground">{value}</span>
    </span>
);

interface FieldRowProps {
    readonly name: string;
    readonly required: boolean;
    readonly schema: SchemaNode;
}

/**
 * One property row: the field name (with a `*` required / `?` optional marker)
 * and type, its description, a wrap of constraint badges, and — when the field
 * is an object (or an array of objects) — a native disclosure that recurses into
 * the nested fields. Mirrors the reference's expandable, badge-annotated schema.
 */
const FieldRow = ({ name, required, schema }: FieldRowProps): ReactElement => {
    const t = useT();

    const range = rangeText(schema);
    const values = valueInText(schema);
    const relation = schema["x-lunora-table"];
    const hasBadges = schema.format !== undefined || range !== undefined || values !== undefined || relation !== undefined;
    const nested = childObject(schema);

    const header = (
        <div className="flex flex-col gap-1 py-2">
            <div className="flex items-baseline gap-2">
                <span className="font-mono text-foreground">
                    {name}
                    <span className="text-muted-foreground">{required ? "*" : "?"}</span>
                </span>
                <span className="font-mono text-muted-foreground">{fieldTypeLabel(schema)}</span>
            </div>
            {schema.description !== undefined && <p className="max-w-prose text-muted-foreground">{schema.description}</p>}
            {hasBadges && (
                <div className="flex flex-wrap gap-1">
                    {schema.format !== undefined && <Badge label={t("Format")} value={schema.format} />}
                    {range !== undefined && <Badge label={t("Range")} value={range} />}
                    {values !== undefined && <Badge label={t("Value in")} value={values} />}
                    {relation !== undefined && <Badge label={t("relation")} value={relation} />}
                </div>
            )}
        </div>
    );

    if (nested === undefined) {
        return <div className="border-b border-border/50 last:border-b-0">{header}</div>;
    }

    return (
        <details className="border-b border-border/50 last:border-b-0">
            <summary className="cursor-pointer marker:text-muted-foreground">{header}</summary>
            <div className="mb-2 ml-2 border-l border-border pl-3">
                {/* eslint-disable-next-line @typescript-eslint/no-use-before-define -- FieldRow and SchemaFields are mutually recursive (a field can nest a sub-schema); one forward reference is unavoidable. */}
                <SchemaFields schema={nested} />
            </div>
        </details>
    );
};

interface SchemaFieldsProps {
    readonly schema: SchemaNode;
}

/** The recursive body: every property of an object schema rendered as a {@link FieldRow}. */
const SchemaFields = ({ schema }: SchemaFieldsProps): ReactElement => {
    const required = new Set(schema.required);
    const rows = Object.entries(schema.properties ?? {});

    return (
        <div className="flex flex-col">
            {rows.map(([name, child]) => (
                <FieldRow key={name} name={name} required={required.has(name)} schema={child} />
            ))}
        </div>
    );
};

interface SchemaTableProps {
    readonly schema: SchemaNode | undefined;
    readonly testId: string;
}

/**
 * Render a schema's fields as an expandable, badge-annotated list: each
 * top-level property shows its type, description, and constraint badges, with
 * object/array-of-object fields drilling into their nested fields on demand. A
 * non-object schema renders a single type label. Shared by the OpenAPI and
 * OpenRPC reference panels.
 */
const SchemaTable = ({ schema, testId }: SchemaTableProps): ReactElement => {
    if (schema?.type !== "object" || Object.keys(schema.properties ?? {}).length === 0) {
        return (
            <p className="font-mono text-xs text-muted-foreground" data-testid={testId}>
                {typeLabel(schema)}
            </p>
        );
    }

    return (
        <div className="text-xs" data-testid={testId}>
            <SchemaFields schema={schema} />
        </div>
    );
};

export type { SchemaNode };
export { exampleForSchema, SchemaTable, typeLabel };

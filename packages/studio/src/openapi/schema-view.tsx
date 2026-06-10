import type { ReactElement } from "react";
import { useMemo } from "react";

import { useT } from "../i18n-context";

/**
 * A JSON-Schema-ish node as it appears in the generated OpenAPI / OpenRPC
 * documents. Cirrus emits a small, predictable subset (objects, arrays, scalars,
 * `const`, `anyOf`), so this models only those fields. The `x-cirrus-table`
 * extension marks an id string that references a table, so the schema table can
 * surface the referenced table name.
 */
interface SchemaNode {
    anyOf?: SchemaNode[];
    const?: unknown;
    description?: string;
    enum?: unknown[];
    items?: SchemaNode;
    properties?: Record<string, SchemaNode>;
    required?: string[];
    type?: string;
    "x-cirrus-table"?: string;
}

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
        return `${typeLabel(schema.items)}[]`;
    }

    return schema.type ?? "any";
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

interface SchemaTableProps {
    readonly schema: SchemaNode | undefined;
    readonly testId: string;
}

/**
 * Render an object schema's top-level properties as a field / type / required
 * table, with the property description and any `x-cirrus-table` relation shown
 * under the field name. A non-object schema renders a single type label. Shared
 * by the OpenAPI and OpenRPC reference panels.
 */
const SchemaTable = ({ schema, testId }: SchemaTableProps): ReactElement => {
    const t = useT();
    const required = useMemo(() => new Set(schema?.required), [schema]);
    const rows = useMemo(() => Object.entries(schema?.properties ?? {}), [schema]);

    if (schema?.type !== "object" || rows.length === 0) {
        return (
            <p className="font-mono text-xs text-muted-foreground" data-testid={testId}>
                {typeLabel(schema)}
            </p>
        );
    }

    return (
        <table className="w-full border-collapse text-xs" data-testid={testId}>
            <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">{t("Field")}</th>
                    <th className="py-1 pr-3 font-medium">{t("Type")}</th>
                    <th className="py-1 font-medium">{t("Required")}</th>
                </tr>
            </thead>
            <tbody>
                {rows.map(([name, child]) => (
                    <tr className="border-b border-border/50 align-top" key={name}>
                        <td className="py-1.5 pr-3">
                            <span className="font-mono text-foreground">{name}</span>
                            {child.description !== undefined && <span className="block max-w-xs text-muted-foreground">{child.description}</span>}
                            {child["x-cirrus-table"] !== undefined && (
                                <span className="block font-mono text-[10px] text-muted-foreground">
                                    {t("relation: {table}", { table: child["x-cirrus-table"] })}
                                </span>
                            )}
                        </td>
                        <td className="py-1.5 pr-3 font-mono text-muted-foreground">{typeLabel(child)}</td>
                        <td className="py-1.5 text-muted-foreground">{required.has(name) ? t("yes") : t("no")}</td>
                    </tr>
                ))}
            </tbody>
        </table>
    );
};

export type { SchemaNode };
export { exampleForSchema, SchemaTable, typeLabel };

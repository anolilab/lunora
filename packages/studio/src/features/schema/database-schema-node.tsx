"use client";

import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import type { ReactElement } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { StorageTierBadge } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { BaseNode, BaseNodeContent, BaseNodeHeader } from "../../components/ui/base-node";
import type { TFunction } from "../../i18n/i18n-context";
import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";

/** One column rendered as a row in a table node. */
interface DatabaseSchemaColumn {
    /** Allowed values of a string-literal union column, when codegen named every one. */
    enumValues?: ReadonlyArray<string>;
    /** `v.storage(...)` column. */
    isStorage?: boolean;
    name: string;
    /** Optional on insert. */
    optional?: boolean;
    /** Primary key — the `_id` column. */
    pk?: boolean;
    /** Foreign-key target table for a `v.id("target")` column. */
    ref?: string;
    /** Display type — the validator IR kind. */
    type: string;
}

/**
 * Node data for the table node. A `type` alias (not an interface) so it
 * satisfies React Flow's `Record<string, unknown>` data constraint.
 */
type DatabaseSchemaNodeData = {
    columns: ReadonlyArray<DatabaseSchemaColumn>;
    label: string;
    /** True when this table's columns failed to load — show a hint, not a bare `—`. */
    loadError?: boolean;
    tier: StorageTier;
};

type DatabaseSchemaNodeType = Node<DatabaseSchemaNodeData, "databaseSchema">;

/**
 * Inline cap on an enum union. A wide union would otherwise push the column name
 * off the node; the full list stays in the row's title.
 */
const INLINE_ENUM_VALUES = 3;

/** A string-literal union as written in source, e.g. `"draft" | "live"`. */
const enumUnion = (values: ReadonlyArray<string>, full: boolean, t: TFunction): string => {
    const shown = full ? values : values.slice(0, INLINE_ENUM_VALUES);
    const union = shown.map((value) => JSON.stringify(value)).join(" | ");
    const hidden = values.length - shown.length;

    return hidden > 0 ? `${union} ${t("+{count} more", { count: hidden })}` : union;
};

/**
 * The display label for a column's type — its enum union when the values are
 * known, else the validator kind — with the FK target for `v.id(ref)` appended.
 * `full` lifts the inline cap for the row's title.
 */
const typeLabel = (column: DatabaseSchemaColumn, full: boolean, t: TFunction): string => {
    const values = column.enumValues ?? [];
    const base = values.length === 0 ? column.type : enumUnion(values, full, t);
    const withRef = column.ref === undefined ? base : `${base} → ${column.ref}`;

    return column.optional === true ? `${withRef}?` : withRef;
};

/**
 * A Supabase-style table node for the schema diagram: a header carrying the
 * table name and its storage-tier badge, then one row per column showing the
 * column name, a PK/FK glyph, and the column's type. Every column row exposes a
 * left **target** and right **source** connection handle (keyed by column name)
 * so foreign-key edges attach handle-to-handle — the PK's right source to the
 * referencing column's left target. Read-only: the canvas disables connecting.
 */
const DatabaseSchemaNode = ({ data, selected }: NodeProps<DatabaseSchemaNodeType>): ReactElement => {
    const t = useT();

    const emptyPlaceholder =
        data.loadError === true ? (
            <span className="px-3 py-1.5 text-xs text-destructive" data-testid={`sd-node-${data.label}-error`}>
                {t("Columns unavailable")}
            </span>
        ) : (
            <span className="px-3 py-1.5 text-xs text-muted-foreground">—</span>
        );

    return (
        <BaseNode className="w-64 overflow-hidden" data-testid={`sd-node-${data.label}`} selected={selected}>
            <BaseNodeHeader>
                <span className="truncate font-mono text-xs font-semibold" title={data.label}>
                    {data.label}
                </span>
                <span className="ms-auto">
                    <StorageTierBadge tier={data.tier} />
                </span>
            </BaseNodeHeader>
            <BaseNodeContent>
                {data.columns.length === 0
                    ? emptyPlaceholder
                    : data.columns.map((column) => (
                          <div
                              className={cn(
                                  "relative flex items-center gap-2 border-t border-border px-3 py-1.5 text-xs first:border-t-0",
                                  column.pk === true && "bg-muted/30",
                              )}
                              data-testid={`sd-col-${data.label}-${column.name}`}
                              key={column.name}
                          >
                              <Handle
                                  className="!h-2 !w-2 !-left-1 !border-border !bg-muted-foreground/70"
                                  id={column.name}
                                  isConnectable={false}
                                  position={Position.Left}
                                  type="target"
                              />
                              <span className="truncate font-mono" title={column.name}>
                                  {column.name}
                              </span>
                              {column.pk === true && (
                                  <Badge className="px-1 py-0 text-[10px] leading-tight" variant="secondary">
                                      PK
                                  </Badge>
                              )}
                              {column.ref !== undefined && (
                                  <Badge className="px-1 py-0 text-[10px] leading-tight" variant="outline">
                                      FK
                                  </Badge>
                              )}
                              <span className="ms-auto truncate text-muted-foreground" title={typeLabel(column, true, t)}>
                                  {typeLabel(column, false, t)}
                              </span>
                              <Handle
                                  className="!h-2 !w-2 !-right-1 !border-border !bg-muted-foreground/70"
                                  id={column.name}
                                  isConnectable={false}
                                  position={Position.Right}
                                  type="source"
                              />
                          </div>
                      ))}
            </BaseNodeContent>
        </BaseNode>
    );
};

export { DatabaseSchemaNode };
export type { DatabaseSchemaColumn, DatabaseSchemaNodeData, DatabaseSchemaNodeType };

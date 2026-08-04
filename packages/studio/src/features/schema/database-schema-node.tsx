"use client";

import type { Node, NodeProps } from "@xyflow/react";
import { Handle, Position } from "@xyflow/react";
import type { ReactElement } from "react";

import type { StorageTier } from "../../components/storage-tier";
import { StorageTierBadge } from "../../components/storage-tier";
import { Badge } from "../../components/ui/badge";
import { BaseNode, BaseNodeContent, BaseNodeHeader } from "../../components/ui/base-node";
import { useT } from "../../i18n/i18n-context";
import { cn } from "../../lib/utils";

/** One column rendered as a row in a table node. */
interface DatabaseSchemaColumn {
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

/** The display label for a column's type — appends the FK target for `v.id(ref)`. */
const typeLabel = (column: DatabaseSchemaColumn): string => {
    const base = column.ref === undefined ? column.type : `${column.type} → ${column.ref}`;

    return column.optional === true ? `${base}?` : base;
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
                              <span className="ms-auto truncate text-muted-foreground" title={typeLabel(column)}>
                                  {typeLabel(column)}
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

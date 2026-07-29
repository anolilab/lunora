import { useLunora } from "@lunora/react";
import { useEffect, useRef, useState } from "react";

import type { TableInfo, TablePage } from "../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../lib/internal";
import type { SqlSchema } from "./sql-autocomplete";

const LIST_TABLES = adminRef(ADMIN_FUNCTIONS.listTables);
const READ_TABLE_PAGE = adminRef(ADMIN_FUNCTIONS.readTablePage);

/**
 * Load the shard's table names (and, lazily, each table's columns) to feed the
 * editor's autocomplete. Tables come from one `listTables`; columns are probed
 * per table with a one-row `readTablePage` (the same RPC the schema viewer
 * uses) the first time the operator types a `tbl.` qualifier or otherwise needs
 * them — so an unexplored schema still completes table names without N probes
 * up front. All best-effort: a failed probe simply leaves that table's columns
 * absent. Re-loads when `shardKey` changes; a fast shard switch discards a stale
 * in-flight list via the cancel token.
 */
/** Pair the table list with its column map — the shape the editor's completion source reads. */
const toSchema = (tables: string[], columns: Record<string, string[]>): { columns: Record<string, string[]>; tables: string[] } => {
    return { columns, tables };
};

const useSqlSchema = (shardKey: string): { probe: (table: string) => void; schema: SqlSchema } => {
    const client = useLunora();

    const [tables, setTables] = useState<string[]>([]);
    const [columns, setColumns] = useState<Record<string, string[]>>({});
    // Tables a probe has already been kicked off for, so `probe` is idempotent
    // without nesting the fetch inside a setState updater. Cleared on shard switch.
    const probed = useRef<Set<string>>(new Set());

    useEffect(() => {
        const token = { cancelled: false };

        const load = async (): Promise<void> => {
            try {
                const result = (await client.query(LIST_TABLES, {}, callOptions(shardKey))) as TableInfo[];

                if (!token.cancelled) {
                    setTables(result.map((table) => table.name));
                    setColumns({});
                    probed.current = new Set();
                }
            } catch {
                if (!token.cancelled) {
                    setTables([]);
                    setColumns({});
                    probed.current = new Set();
                }
            }
        };

        fireAndForget(load());

        return () => {
            token.cancelled = true;
        };
    }, [client, shardKey]);

    // Fetch one table's columns once, on demand; a failure leaves it un-probed so
    // a later call can retry. Keyed by table only — the effect above resets the
    // cache on a shard switch, so a stale shard's columns can't bleed through.
    const probe = (table: string): void => {
        if (probed.current.has(table)) {
            return;
        }

        probed.current.add(table);

        const fetchColumns = async (): Promise<void> => {
            try {
                const page = (await client.query(READ_TABLE_PAGE, { limit: 1, offset: 0, table }, callOptions(shardKey))) as TablePage;

                setColumns((previous) => {
                    return { ...previous, [table]: page.columns };
                });
            } catch {
                // Best-effort: drop the in-flight marker so a later probe can retry.
                probed.current.delete(table);
            }
        };

        fireAndForget(fetchColumns());
    };

    // Referentially stable while the data is unchanged, so consumers (the
    // autocomplete's `refresh` callback and the panel's probe-refresh effect)
    // can depend on it without re-firing after every render.
    const schema = toSchema(tables, columns);

    return { probe, schema };
};

/** Table names referenced in `sql` after `FROM`/`JOIN`/`UPDATE`/`INTO`, or as a `tbl.` qualifier. */
const TABLE_REF = /\b(?:from|join|update|into)\s+([a-z_][\w$]*)|\b([a-z_][\w$]*)\s*\./gi;

/** Mentioned table names in a draft, so the schema hook can pre-probe their columns for column completion. */
const referencedTables = (sql: string): string[] => {
    const names = new Set<string>();

    TABLE_REF.lastIndex = 0;
    let match: null | RegExpExecArray = TABLE_REF.exec(sql);

    while (match !== null) {
        names.add((match[1] ?? match[2]) as string);
        match = TABLE_REF.exec(sql);
    }

    return [...names];
};

export { referencedTables, useSqlSchema };

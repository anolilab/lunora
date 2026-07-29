import { useLunora } from "@lunora/react";
import { useCallback, useEffect, useState } from "react";

import type { SqlConsoleResult } from "../../../lib/admin";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, errorMessage, fireAndForget } from "../../../lib/internal";

const RUN_SQL = adminRef(ADMIN_FUNCTIONS.runSql);

/** The lifecycle of a single read-only SQL run: at most one of `result`/`error` is set once `loading` clears. */
export interface RunSqlState {
    readonly error: string | undefined;
    readonly loading: boolean;
    readonly result: SqlConsoleResult | undefined;
}

/**
 * Run a read-only SQL query through the gated `runSql` admin RPC and expose its
 * `{ result, error, loading }` lifecycle, re-running whenever `sql` or `shardKey`
 * changes. A cancel token discards a stale or unmounted in-flight result, so a
 * fast edit — or a scrolled-away dashboard tile — never sets state late. Extracted
 * from the dashboards `WidgetCard` so every panel that charts a saved query shares
 * one audited run/cancel path rather than re-deriving it per component.
 */
export const useRunSql = (sql: string, shardKey: string): RunSqlState => {
    const client = useLunora();

    const [result, setResult] = useState<SqlConsoleResult | undefined>(undefined);
    const [error, setError] = useState<string | undefined>(undefined);
    const [loading, setLoading] = useState<boolean>(true);

    // Kept in a callback (not inline in the effect) so the setState calls aren't
    // flagged as synchronous effect writes; the `token` lets a re-run/unmount
    // discard a stale in-flight result.
    const run = useCallback(
        async (token: { cancelled: boolean }): Promise<void> => {
            setLoading(true);

            try {
                const next = (await client.query(RUN_SQL, { sql }, callOptions(shardKey))) as SqlConsoleResult;

                if (!token.cancelled) {
                    setResult(next);
                    setError(undefined);
                }
            } catch (error_) {
                if (!token.cancelled) {
                    setResult(undefined);
                    setError(errorMessage(error_));
                }
            }

            if (!token.cancelled) {
                setLoading(false);
            }
        },
        [client, sql, shardKey],
    );

    useEffect(() => {
        const token = { cancelled: false };

        // react-doctor-disable-next-line react-hooks-js/set-state-in-effect -- async run with a cancellation token, which is what effects are for
        fireAndForget(run(token));

        return () => {
            token.cancelled = true;
        };
    }, [run]);

    return { error, loading, result };
};

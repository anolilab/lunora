import { useLunora } from "@lunora/react";
import { useCallback, useEffect, useMemo, useState } from "react";

import useDebounced from "../../../hooks/use-debounced";
import { ADMIN_FUNCTIONS } from "../../../lib/admin";
import { adminRef, callOptions, fireAndForget } from "../../../lib/internal";
import type { SqlSchema } from "../sql-autocomplete";
import type { SqlDiagnostic } from "../sql-diagnostics";
import { lintDraft } from "../sql-diagnostics";

const LINT_SQL = adminRef(ADMIN_FUNCTIONS.lintSql);

/**
 * How long the draft must sit still before the SERVER lint fires. Longer than
 * the client pass on purpose: the client rules are pure and free, the server
 * round trip is not, and one lint per pause is the contract (never one per
 * keystroke).
 */
const SERVER_LINT_DELAY = 600;

/** Shape of a `__lunora_admin__:lintSql` reply. Mirrors `@lunora/do`'s `SqlLintResult`. */
interface LintReply {
    readonly diagnostics?: ReadonlyArray<SqlDiagnostic>;
    readonly plan?: ReadonlyArray<string>;
}

/**
 * Lint the SQL draft from two sources and merge them.
 *
 * The client pass (`lintDraft`) is pure and runs on every render — it is the one
 * that must never lag, because it carries the read-only gate. The server pass
 * (`lintSql`) is debounced and best-effort: it adds syntax errors and query-plan
 * warnings that only the database can know.
 *
 * **Capability fallback.** A worker predating `lintSql` simply rejects the call,
 * and the hook keeps the client diagnostics with no error surfaced — the same
 * best-effort posture the advisors panel takes for `shardTraffic`. An editor
 * that shows a red banner because an *optional* lint is unavailable would be
 * worse than one that quietly lints less.
 */
const useSqlDiagnostics = (draft: string, schema: SqlSchema, shardKey: string): ReadonlyArray<SqlDiagnostic> => {
    const client = useLunora();

    const [serverDiagnostics, setServerDiagnostics] = useState<ReadonlyArray<SqlDiagnostic>>([]);

    // Pure, synchronous, and the only pass that gates. Memoized so a re-render
    // that changes neither the draft nor the schema doesn't re-scan the text.
    const clientDiagnostics = useMemo(() => lintDraft(draft, schema), [draft, schema]);

    const settledDraft = useDebounced(draft, SERVER_LINT_DELAY);

    // The client pass already refused this statement (or there is nothing to
    // lint) — asking the server to plan it would be a round trip whose answer we
    // could not use, and would double up on the same message.
    const gated = clientDiagnostics.some((diagnostic) => diagnostic.source === "gate");
    const skipServer = gated || settledDraft.trim() === "";

    const lint = useCallback(
        async (token: { cancelled: boolean }): Promise<void> => {
            try {
                const reply = (await client.query(LINT_SQL, { sql: settledDraft }, callOptions(shardKey))) as LintReply;

                if (!token.cancelled) {
                    setServerDiagnostics(reply.diagnostics ?? []);
                }
            } catch {
                // Best-effort: an older worker has no `lintSql`, and a transient
                // failure is not worth a banner. Drop back to client-only.
                if (!token.cancelled) {
                    setServerDiagnostics([]);
                }
            }
        },
        [client, settledDraft, shardKey],
    );

    useEffect(() => {
        if (skipServer) {
            setServerDiagnostics([]);

            return undefined;
        }

        // Supersede the previous lint rather than letting both resolve: a stale
        // reply landing after a newer one would underline text that has moved.
        const token = { cancelled: false };

        fireAndForget(lint(token));

        return () => {
            token.cancelled = true;
        };
    }, [lint, skipServer]);

    // Server diagnostics are dropped while the draft is mid-edit (the debounced
    // text has diverged from what is on screen), because their offsets refer to
    // the settled text and would underline the wrong characters.
    const serverIsCurrent = settledDraft === draft;

    return useMemo(
        () => (serverIsCurrent ? [...clientDiagnostics, ...serverDiagnostics] : clientDiagnostics),
        [clientDiagnostics, serverDiagnostics, serverIsCurrent],
    );
};

export { SERVER_LINT_DELAY, useSqlDiagnostics };

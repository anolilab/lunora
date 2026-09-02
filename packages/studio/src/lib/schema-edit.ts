/**
 * Tiny client for the studio's local schema-edit endpoint (plan 024). This is
 * NOT a worker admin RPC: it talks to the dev host (the `@lunora/vite`
 * middleware or the `lunora dev` studio server) over a same-origin `fetch`, and
 * the host mutates `lunora/schema.ts` + reruns codegen on disk. It is reachable
 * only in local dev (the host 403s the route on a non-loopback bind), so it
 * carries no admin token.
 *
 * Both hosts mount the handler at the absolute path below — independent of the
 * studio's `basePath` — so the client targets it directly. Keep this in sync
 * with `SCHEMA_EDIT_ENDPOINT` in `@lunora/config/studio-host`.
 */

/** Endpoint both dev hosts mount the schema-edit handler at. */
const SCHEMA_EDIT_ENDPOINT = "/__lunora/schema-edit";

/** An additive edit the overlay can apply directly. */
type AdditiveEdit =
    | { fields: ReadonlyArray<string>; kind: "addIndex"; name: string; table: string; unique?: boolean }
    | { column: string; kind: "addOptionalColumn"; table: string; validator: string }
    | { kind: "addTable"; table: string };

/** A table as returned by the endpoint (a subset of the config parser's shape). */
interface SchemaEditTable {
    readonly columns: ReadonlyArray<{ name: string; optional: boolean; validator: string }>;
    readonly global: boolean;
    readonly indexes: ReadonlyArray<{ fields: ReadonlyArray<string>; name: string; unique: boolean }>;
    readonly name: string;
}

/** Outcome of an additive apply or a destructive rejection. */
type SchemaEditResult =
    | { kind: "error"; message: string }
    | { kind: "needs-migration"; message: string }
    | { diagnostics: ReadonlyArray<string>; kind: "ok"; tables: ReadonlyArray<SchemaEditTable> };

/** Apply an additive edit through the dev host, normalising every outcome. */
const applyEdit = async (edit: AdditiveEdit): Promise<SchemaEditResult> => {
    const response = await fetch(SCHEMA_EDIT_ENDPOINT, {
        body: JSON.stringify(edit),
        // `Content-Type: application/json` is the one header the host's
        // `csrfRejectionReason` guard actually requires on a state-changing
        // request: it is non-simple, so a cross-origin form/text POST is
        // preflighted (and the preflight gets a 403 with no CORS headers). The
        // guard's other layer is the request's own `Sec-Fetch-Site` / `Origin`;
        // no custom header is checked, and the sibling seed client sends none.
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
    const body = (await response.json()) as {
        diagnostics?: ReadonlyArray<string>;
        error?: string;
        message?: string;
        needsMigration?: boolean;
        tables?: ReadonlyArray<SchemaEditTable>;
    };

    if (body.needsMigration === true) {
        return { kind: "needs-migration", message: body.message ?? "This edit needs a migration." };
    }

    if (response.ok && body.tables !== undefined) {
        return { diagnostics: body.diagnostics ?? [], kind: "ok", tables: body.tables };
    }

    return { kind: "error", message: body.error ?? `schema edit failed (${String(response.status)})` };
};

export type { AdditiveEdit, SchemaEditResult, SchemaEditTable };
export { applyEdit, SCHEMA_EDIT_ENDPOINT };

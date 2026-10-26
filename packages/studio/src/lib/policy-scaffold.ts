/**
 * Tiny client for the studio's local policy-scaffold endpoint (plan 025
 * Item 3) — the RLS sibling of {@link ./schema-edit}. Like the schema editor it
 * is NOT a worker admin RPC: it talks to the dev host (the `@lunora/vite`
 * middleware or the `lunora dev` studio server) over a same-origin `fetch`, and
 * the host writes a new policy stub (or appends `.use(rls(...))` to a procedure)
 * + reruns codegen on disk. Reachable only in local dev (the host 403s the route
 * on a non-loopback bind), so it carries no admin token.
 *
 * Both hosts mount the handler at the absolute path below — independent of the
 * studio's `basePath`. Keep this in sync with `POLICY_SCAFFOLD_ENDPOINT` in
 * `@lunora/config/studio-host`.
 */

/** Endpoint both dev hosts mount the policy-scaffold handler at. */
const POLICY_SCAFFOLD_ENDPOINT = "/__lunora/policy-scaffold";

/** Write a new deny-by-default `name.policies.ts` stub. */
interface ScaffoldPolicyRequest {
    readonly kind: "scaffoldPolicy";
    /** Base name for the file + exported policy set, e.g. `invoices`. */
    readonly name: string;
    /** Logical table the scaffolded policy guards. */
    readonly table: string;
}

/** Append a `.use(rls(...))` call to an existing procedure's builder chain. */
interface WireRlsRequest {
    /** Exported procedure name to wire, e.g. `listInvoices`. */
    readonly exportName: string;
    /** Lunora-relative module path of the procedure file (no extension), e.g. `messages`. */
    readonly filePath: string;
    readonly kind: "wireRls";
    /** Identifier of the policy set passed to `rls(...)`, e.g. `invoicesPolicies`. */
    readonly policies: string;
}

/** Any scaffolder request the control can issue. */
type PolicyScaffoldRequest = ScaffoldPolicyRequest | WireRlsRequest;

/**
 * Human-readable copy for the host's machine failure tokens, so the panel shows
 * a sentence rather than a raw slug like `already-wired`. An unknown token (a
 * newer host, an `invalid-json`/`invalid-edit` protocol error) falls back to the
 * token itself so nothing is swallowed.
 */
const FAILURE_MESSAGES: Readonly<Record<string, string>> = {
    "already-wired": "That procedure already has an rls(...) policy wired in.",
    "file-exists": "A policy file with that name already exists — pick another name or edit it by hand.",
    "invalid-identifier": "Name, table, and policy-set must be plain identifiers (letters, digits, _ or $).",
    "unknown-procedure": "No exported procedure was found at that file path.",
    "unsupported-procedure-shape": "That procedure uses the bare query({…}) form — convert it to the builder form (c.use(…).query(…)) before wiring RLS.",
};

/** Outcome of a scaffold/wire apply, normalising every host response. */
type PolicyScaffoldResult =
    | { diagnostics: ReadonlyArray<string>; kind: "ok"; label: string }
    | { kind: "error"; message: string }
    | { kind: "needs-manual-edit"; message: string };

/** Apply a scaffolder request through the dev host, normalising every outcome. */
const applyPolicyScaffold = async (request: PolicyScaffoldRequest): Promise<PolicyScaffoldResult> => {
    const response = await fetch(POLICY_SCAFFOLD_ENDPOINT, {
        body: JSON.stringify(request),
        headers: { "Content-Type": "application/json" },
        method: "POST",
    });
    const body = (await response.json()) as {
        diagnostics?: ReadonlyArray<string>;
        error?: string;
        exportName?: string;
        fileName?: string;
        message?: string;
        needsManualEdit?: boolean;
    };

    if (body.needsManualEdit === true) {
        return { kind: "needs-manual-edit", message: body.message ?? "This change must be made by hand." };
    }

    if (response.ok) {
        return { diagnostics: body.diagnostics ?? [], kind: "ok", label: body.fileName ?? body.exportName ?? "" };
    }

    const token = body.error;
    const message = token === undefined ? `policy scaffold failed (${String(response.status)})` : (FAILURE_MESSAGES[token] ?? token);

    return { kind: "error", message };
};

export type { PolicyScaffoldRequest, PolicyScaffoldResult, ScaffoldPolicyRequest, WireRlsRequest };
export { applyPolicyScaffold, POLICY_SCAFFOLD_ENDPOINT };

/**
 * Serves the advisor procedure list to the studio's health map. The list is the
 * health map's denominator and Studio-only data, so codegen writes it to
 * `_generated/advisor-procedures.json` instead of embedding it in the main app
 * Worker. The dev hosts mount this read-only handler on a loopback bind; a hosted
 * Studio reads the same document from the opt-in companion Worker
 * (`studio.companion`), which the app's Worker forwards to after its admin check.
 *
 * Transport-agnostic like its siblings: it takes a {@link LocalEndpointRequest}
 * and returns a {@link LocalEndpointResponse}. A missing file is a 404 with a
 * reason, not an empty list, so the studio cannot show a score computed from a
 * denominator that was never generated.
 */
import { readFileSync } from "node:fs";

import join from "../path";
import type { LocalEndpointRequest, LocalEndpointResponse } from "./serve-json-handler";

/**
 * Endpoint path both dev hosts mount the handler at. Sits under the double-underscore
 * prefix, clear of the CLI's `/_lunora/*` worker proxy.
 */
const ADVISOR_PROCEDURES_ENDPOINT = "/__lunora/advisor-procedures";

/** Name of the generated file codegen writes into `<schemaDirectory>/_generated/`. */
const ADVISOR_PROCEDURES_FILE = "advisor-procedures.json";

const PROCEDURE_KINDS: ReadonlySet<unknown> = new Set(["action", "mutation", "query"]);
const PROCEDURE_VISIBILITIES: ReadonlySet<unknown> = new Set(["internal", "public"]);

/** The fields `scoreAdvisor` reads unconditionally; the optional behavioural facts are left to it. */
const isProcedureEntry = (entry: unknown): boolean => {
    if (typeof entry !== "object" || entry === null) {
        return false;
    }

    const row = entry as Record<string, unknown>;

    return (
        typeof row["exportName"] === "string" &&
        typeof row["file"] === "string" &&
        PROCEDURE_KINDS.has(row["kind"]) &&
        PROCEDURE_VISIBILITIES.has(row["visibility"]) &&
        ["usesCaptcha", "usesEmailGate", "usesMask", "usesRateLimit", "usesRls"].every((field) => typeof row[field] === "boolean")
    );
};

const handleAdvisorProceduresRequest = (request: LocalEndpointRequest): LocalEndpointResponse => {
    if (request.method !== "GET") {
        return { body: { error: "GET only" }, status: 405 };
    }

    const path = join(request.projectRoot, request.schemaDirectory ?? "lunora", "_generated", ADVISOR_PROCEDURES_FILE);

    // Read directly instead of probing with `existsSync` first: codegen can rewrite the file between the two calls.
    let source: string;

    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            return { body: { error: "advisor-procedures.json is not generated yet; run `lunora codegen`." }, status: 404 };
        }

        // eslint-disable-next-line no-console -- the response body is the studio's, so the cause is logged here for the dev server operator
        console.error(`@lunora/config: could not read ${path}`, error);

        return { body: { error: "advisor-procedures.json could not be read; see the dev server log." }, status: 500 };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(source);
    } catch {
        return { body: { error: "advisor-procedures.json is not valid JSON; re-run `lunora codegen`." }, status: 500 };
    }

    if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { procedures?: unknown }).procedures)) {
        return { body: { error: "advisor-procedures.json has no procedures array; re-run `lunora codegen`." }, status: 500 };
    }

    if (!(parsed as { procedures: unknown[] }).procedures.every((entry) => isProcedureEntry(entry))) {
        return { body: { error: "advisor-procedures.json has a malformed procedure entry; re-run `lunora codegen`." }, status: 500 };
    }

    return { body: parsed, status: 200 };
};

export { ADVISOR_PROCEDURES_ENDPOINT, handleAdvisorProceduresRequest };

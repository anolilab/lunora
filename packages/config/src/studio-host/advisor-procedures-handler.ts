/**
 * Serves the advisor procedure list to the studio's health map. The list is the
 * health map's denominator, and it is Studio-only data, so codegen writes it to
 * `_generated/advisor-procedures.json` instead of embedding it in the deployed
 * worker. The dev hosts mount this read-only handler on a loopback bind, so the
 * worker never carries the list.
 *
 * Transport-agnostic like its siblings: it takes a {@link LocalEndpointRequest}
 * and returns a {@link LocalEndpointResponse}. A missing file is a 404 with a
 * reason, not an empty list, so the studio cannot show a score computed from a
 * denominator that was never generated.
 */
import { existsSync, readFileSync } from "node:fs";

import join from "../path";
import type { LocalEndpointRequest, LocalEndpointResponse } from "./serve-json-handler";

/**
 * Endpoint path both dev hosts mount the handler at. Sits under the double-underscore
 * prefix, clear of the CLI's `/_lunora/*` worker proxy.
 */
const ADVISOR_PROCEDURES_ENDPOINT = "/__lunora/advisor-procedures";

/** Name of the generated file codegen writes into `<schemaDirectory>/_generated/`. */
const ADVISOR_PROCEDURES_FILE = "advisor-procedures.json";

/**
 * The fields `scoreAdvisor` dereferences on every row. Checked here so a corrupt
 * sidecar is a 500 with a reason rather than a `TypeError` in the health panel.
 */
const isProcedureEntry = (entry: unknown): boolean => {
    if (typeof entry !== "object" || entry === null) {
        return false;
    }

    const { exportName, file, kind, visibility } = entry as Record<string, unknown>;

    return typeof exportName === "string" && typeof file === "string" && typeof kind === "string" && typeof visibility === "string";
};

const handleAdvisorProceduresRequest = (request: LocalEndpointRequest): LocalEndpointResponse => {
    if (request.method !== "GET") {
        return { body: { error: "GET only" }, status: 405 };
    }

    const path = join(request.projectRoot, request.schemaDirectory ?? "lunora", "_generated", ADVISOR_PROCEDURES_FILE);

    if (!existsSync(path)) {
        return {
            body: { error: "advisor-procedures.json is not generated yet; run `lunora codegen`." },
            status: 404,
        };
    }

    let source: string;

    try {
        source = readFileSync(path, "utf8");
    } catch (error) {
        // eslint-disable-next-line no-console -- dev-host diagnostic; the studio hosts have no shared logger at this seam.
        console.error(`[lunora] could not read ${path}:`, error);

        return { body: { error: "advisor-procedures.json could not be read; see the dev server log." }, status: 500 };
    }

    let parsed: unknown;

    try {
        parsed = JSON.parse(source);
    } catch {
        return { body: { error: "advisor-procedures.json is not valid JSON; re-run `lunora codegen`." }, status: 500 };
    }

    const procedures = typeof parsed === "object" && parsed !== null ? (parsed as { procedures?: unknown }).procedures : undefined;

    if (!Array.isArray(procedures)) {
        return { body: { error: "advisor-procedures.json has no procedures array; re-run `lunora codegen`." }, status: 500 };
    }

    if (!procedures.every((entry) => isProcedureEntry(entry))) {
        return { body: { error: "advisor-procedures.json has a malformed procedure entry; re-run `lunora codegen`." }, status: 500 };
    }

    return { body: parsed, status: 200 };
};

export { ADVISOR_PROCEDURES_ENDPOINT, handleAdvisorProceduresRequest };

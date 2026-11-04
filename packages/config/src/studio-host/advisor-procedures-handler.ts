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

    try {
        const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));

        if (typeof parsed !== "object" || parsed === null || !Array.isArray((parsed as { procedures?: unknown }).procedures)) {
            return { body: { error: "advisor-procedures.json has no procedures array; re-run `lunora codegen`." }, status: 500 };
        }

        return { body: parsed, status: 200 };
    } catch {
        return { body: { error: "advisor-procedures.json is not valid JSON; re-run `lunora codegen`." }, status: 500 };
    }
};

export { ADVISOR_PROCEDURES_ENDPOINT, handleAdvisorProceduresRequest };

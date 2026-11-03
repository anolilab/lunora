import { useQuery } from "@tanstack/react-query";

import type { AdvisorProceduresResult } from "../../lib/admin";
import { errorMessage } from "../../lib/internal";

/**
 * Dev-host route that serves `_generated/advisor-procedures.json` (see
 * `@lunora/config/studio-host`). Kept out of the worker: the procedure list is
 * Studio-only data, so the health map reads it from the local host instead of
 * an admin RPC.
 */
const ADVISOR_PROCEDURES_ENDPOINT = "/__lunora/advisor-procedures";

const fetchAdvisorProcedures = async (): Promise<AdvisorProceduresResult> => {
    const response = await fetch(ADVISOR_PROCEDURES_ENDPOINT);

    if (!response.ok) {
        const body: unknown = await response.json().catch(() => undefined);
        const reason = typeof body === "object" && body && "error" in body ? String(body.error) : `HTTP ${String(response.status)}`;

        throw new Error(reason);
    }

    return (await response.json()) as AdvisorProceduresResult;
};

/**
 * The health map's denominator. Returns `error` as a message string, matching
 * the admin query hooks the panel reads next to it. The file changes only on
 * codegen, so it is refetched on mount and on focus, not polled.
 */
const useAdvisorProcedures = (): { data: AdvisorProceduresResult | undefined; error: string | undefined } => {
    const query = useQuery({ queryFn: fetchAdvisorProcedures, queryKey: ["studio", "advisor-procedures"] });

    return { data: query.data, error: query.error ? errorMessage(query.error) : undefined };
};

export default useAdvisorProcedures;

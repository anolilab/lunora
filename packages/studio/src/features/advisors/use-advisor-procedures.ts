import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { AdvisorProceduresResult } from "../../lib/admin";
import { errorMessage } from "../../lib/internal";

/**
 * Dev-host route that serves `_generated/advisor-procedures.json` (see
 * `@lunora/config/studio-host`). Kept out of the worker: the procedure list is
 * Studio-only data, so the health map reads it from the local host instead of
 * an admin RPC. Only the dev hosts mount it; a static deploy has no such route.
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

interface AdvisorProceduresOptions {
    /** `false` on a host that cannot serve the route: no request is made. */
    readonly enabled: boolean;

    /**
     * Changes whenever the numerator changes (the live advisories). A new value
     * refetches the procedures too, so the score never mixes a fresh finding list
     * with a denominator from before a codegen run.
     */
    readonly refreshKey: unknown;
}

/**
 * The health map's denominator. Returns `error` as a message string, matching
 * the admin query hooks the panel reads next to it.
 */
const useAdvisorProcedures = ({ enabled, refreshKey }: AdvisorProceduresOptions): { data: AdvisorProceduresResult | undefined; error: string | undefined } => {
    const query = useQuery({ enabled, queryFn: fetchAdvisorProcedures, queryKey: ["studio", "advisor-procedures"] });
    const { refetch } = query;
    const previousKey = useRef(refreshKey);

    useEffect(() => {
        if (enabled && previousKey.current !== refreshKey) {
            previousKey.current = refreshKey;
            // A failed refetch is already recorded on the query's `error`, so the rejection is not re-raised here.
            refetch().catch(() => undefined);
        }
    }, [enabled, refreshKey, refetch]);

    return { data: query.data, error: query.error ? errorMessage(query.error) : undefined };
};

export default useAdvisorProcedures;

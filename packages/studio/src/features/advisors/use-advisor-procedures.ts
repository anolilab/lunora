import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useState } from "react";

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
    // Bump a revision when the advisories change and key the query on it, so React
    // Query fetches once per change. The first value (advisories still loading →
    // loaded) is not a change: the mount fetch already covers it.
    const [seenKey, setSeenKey] = useState(refreshKey);
    const [revision, setRevision] = useState(0);

    if (seenKey !== refreshKey) {
        setSeenKey(refreshKey);

        if (seenKey !== undefined) {
            setRevision((current) => current + 1);
        }
    }

    const query = useQuery({
        enabled,
        // Hold the previous list while a new revision loads, so the score does not flash to a spinner.
        placeholderData: keepPreviousData,
        queryFn: fetchAdvisorProcedures,
        queryKey: ["studio", "advisor-procedures", revision],
        // Codegen can rewrite the sidecar without any advisory changing (a clean
        // procedure added or removed), so poll while the panel is open as well.
        refetchInterval: 60_000,
        // The app's QueryClient defaults to an infinite staleTime; refetch on mount and focus instead.
        staleTime: 0,
    });

    return { data: query.data, error: query.error ? errorMessage(query.error) : undefined };
};

export default useAdvisorProcedures;

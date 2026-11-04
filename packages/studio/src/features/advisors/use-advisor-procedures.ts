import { useQuery } from "@tanstack/react-query";
import { useEffect, useRef } from "react";

import type { AdvisorProceduresResult } from "../../lib/admin";
import { errorMessage } from "../../lib/internal";

/**
 * Dev-host route that serves `_generated/advisor-procedures.json` (see
 * `@lunora/config/studio-host`). Kept out of the worker: the procedure list is
 * Studio-only data, so the health map reads it from the local host instead of
 * an admin RPC.
 */
const ADVISOR_PROCEDURES_ENDPOINT = "/__lunora/advisor-procedures";

/** A hosted Studio's worker: where to fetch from and the admin bearer to present. */
interface RemoteProceduresSource {
    readonly baseUrl: string;
    readonly token: string;
}

/**
 * The worker answered 404 for the remote route: it forwards to the companion
 * worker, which is not deployed. Distinct from a dev host's 404, which means
 * `lunora codegen` has not written the list yet.
 */
class CompanionNotDeployedError extends Error {
    public constructor() {
        super("companion not deployed");
        this.name = "CompanionNotDeployedError";
    }
}

const fetchAdvisorProcedures = async (remote: RemoteProceduresSource | undefined): Promise<AdvisorProceduresResult> => {
    const response =
        remote === undefined
            ? await fetch(ADVISOR_PROCEDURES_ENDPOINT)
            : await fetch(`${remote.baseUrl}${ADVISOR_PROCEDURES_ENDPOINT}`, { headers: { authorization: `Bearer ${remote.token}` } });

    if (remote !== undefined && response.status === 404) {
        throw new CompanionNotDeployedError();
    }

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

    /** Set on a hosted Studio: fetch from this worker with the bearer instead of the same origin. */
    readonly remote?: RemoteProceduresSource;
}

/**
 * The health map's denominator. Returns `error` as a message string, matching
 * the admin query hooks the panel reads next to it.
 */
const useAdvisorProcedures = ({
    enabled,
    refreshKey,
    remote,
}: AdvisorProceduresOptions): {
    data: AdvisorProceduresResult | undefined;
    error: string | undefined;
    notDeployed: boolean;
} => {
    const query = useQuery({
        enabled,
        queryFn: () => fetchAdvisorProcedures(remote),
        // The source is a query input: a new worker or token must not be served the previous one's list.
        queryKey: ["studio", "advisor-procedures", remote],
    });
    const { refetch } = query;
    const previousKey = useRef(refreshKey);

    useEffect(() => {
        if (enabled && previousKey.current !== refreshKey) {
            previousKey.current = refreshKey;
            // A failed refetch is already recorded on the query's `error`, so the rejection is not re-raised here.
            refetch().catch(() => undefined);
        }
    }, [enabled, refreshKey, refetch]);

    return {
        data: query.data,
        error: query.error ? errorMessage(query.error) : undefined,
        notDeployed: query.error instanceof CompanionNotDeployedError,
    };
};

export default useAdvisorProcedures;

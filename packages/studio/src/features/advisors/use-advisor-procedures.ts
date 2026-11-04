import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import type { AdvisorProceduresResult } from "../../lib/admin";
import { errorMessage, workerBaseUrl } from "../../lib/internal";

/**
 * Host route that serves `_generated/advisor-procedures.json` (see
 * `@lunora/config/studio-host`). Kept out of the worker: the procedure list is
 * Studio-only data, so the health map reads it from the host instead of an
 * admin RPC.
 */
const ADVISOR_PROCEDURES_ENDPOINT = "/__lunora/advisor-procedures";

/**
 * How often an open panel re-reads the list. Codegen rewrites it while the studio
 * runs — on every dev save, and once per deploy — and the query key cannot see
 * that, so without a poll a panel opened before the rewrite keeps scoring the old
 * roster until it remounts.
 */
const ADVISOR_PROCEDURES_REFRESH_MS = 60_000;

/** A hosted Studio's worker: where to fetch from and the admin bearer to present. */
interface RemoteProceduresSource {
    readonly baseUrl: string;
    readonly token: string;
}

/**
 * Where this host can read the health map's denominator. `"local"` is a dev host
 * serving the generated file itself, `"remote"` a hosted Studio reaching the
 * companion through its worker, and `"none"` neither — which the panel renders as
 * a notice instead of scoring.
 */
type AdvisorProceduresSource = { readonly kind: "local" } | { readonly kind: "none" } | { readonly kind: "remote"; readonly remote: RemoteProceduresSource };

/**
 * Resolve the source from the two host flags. The local route wins: a dev host
 * serves the file it generated. Otherwise a hosted Studio reads it from the worker
 * it already talks to, provided it has the admin token that route is gated on;
 * without one the panel says what is missing rather than firing a request that
 * would only come back 401.
 */
const resolveAdvisorProceduresSource = (options: {
    readonly advisorCompanion: boolean;
    readonly localProcedures: boolean;
    readonly token: null | string;
    readonly workerUrl: string;
}): AdvisorProceduresSource => {
    if (options.localProcedures) {
        return { kind: "local" };
    }

    if (options.advisorCompanion && options.token !== null && options.token !== "") {
        return { kind: "remote", remote: { baseUrl: workerBaseUrl(options.workerUrl), token: options.token } };
    }

    return { kind: "none" };
};

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

    if (response.ok && !(response.headers.get("content-type") ?? "").includes("application/json")) {
        // A host without the route falls through to the SPA shell: HTML with a 200, which would fail as a raw parse error.
        throw new Error("The advisor procedure route is not available on this host.");
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
        queryFn: () => fetchAdvisorProcedures(remote),
        // The source is a query input: a new worker or token must not be served the previous one's list.
        queryKey: ["studio", "advisor-procedures", remote, revision],
        refetchInterval: ADVISOR_PROCEDURES_REFRESH_MS,
        // No retries: a 404/500 is a state the host reports, and retrying would keep the panel on "Loading" for seconds first.
        retry: false,
        // The studio's client defaults to `staleTime: Infinity`. Generated output changes without the key changing,
        // so this query must refetch on mount and on window focus instead of serving the cache indefinitely.
        staleTime: 0,
    });

    return {
        data: query.data,
        error: query.error ? errorMessage(query.error) : undefined,
        notDeployed: query.error instanceof CompanionNotDeployedError,
    };
};

export { resolveAdvisorProceduresSource, useAdvisorProcedures };

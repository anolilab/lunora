"use client";

import type { FunctionReference } from "@lunora/client";

import useSubscription from "./use-subscription";

/**
 * One human-in-the-loop approval a run is paused on, on a thread the caller
 * owns. Carries the triple `agents.agentResolveApproval` takes, so a UI can
 * approve or reject straight from the list.
 */
interface PendingApproval {
    agent: string;
    content: string;
    instanceId: string;
    requestedAt: number;
    threadKey: string;
    threadTitle?: string;
    threadUpdatedAt: number;
    toolCallId: string;
    toolName?: string;
}

/**
 * The `agents.agentPendingApprovals` reference the hook subscribes to. A
 * structural subset of the generated `api.agents` surface, so the whole
 * generated `api` object is assignable. Typed as a loose record for the same
 * reason `useAgentState` is: codegen cannot see the runtime row shape, so the
 * hook casts to {@link PendingApproval}.
 */
interface UseAgentApprovalsApi {
    agents: {
        agentPendingApprovals: FunctionReference<"query", { limit?: number }, Record<string, unknown>[]>;
    };
}

interface UseAgentApprovalsOptions {
    /** The generated `api` — its `agents.agentPendingApprovals` query drives the inbox. */
    api: UseAgentApprovalsApi;
}

interface UseAgentApprovalsResult {
    /** The caller's pending approvals, newest thread first; `undefined` before the first frame. */
    approvals: PendingApproval[] | undefined;
    /** The subscription error, if the live channel reported one. */
    error: Error | undefined;
}

/**
 * Subscribe to the caller's approvals inbox: every run of theirs currently
 * paused on a gated tool. A thin wrapper over
 * `useSubscription(api.agents.agentPendingApprovals, {})` — the server pushes a
 * fresh list whenever a pause starts or is resolved. Anonymous callers receive
 * an empty list.
 */
const useAgentApprovals = (options: UseAgentApprovalsOptions): UseAgentApprovalsResult => {
    const { data, error } = useSubscription(options.api.agents.agentPendingApprovals, {});

    return { approvals: data as PendingApproval[] | undefined, error };
};

export type { PendingApproval, UseAgentApprovalsApi, UseAgentApprovalsOptions, UseAgentApprovalsResult };
export { useAgentApprovals };

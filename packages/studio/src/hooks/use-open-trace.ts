import { useNavigate } from "@tanstack/react-router";

import { fireAndForget } from "../lib/internal";
import { writePendingTraceFilter } from "../lib/trace-handoff";

/**
 * The trace drill-down every panel with a trace id shares: stash the one-shot
 * hand-off — with the shard the row was read from, so Traces searches that ring
 * rather than the root's — then navigate to the Traces page, which consumes the
 * hand-off on mount and pre-filters.
 *
 * Bundling the navigate with the write is the point: a caller that stashes but
 * forgets to navigate leaves a filter that silently applies to the user's NEXT
 * manual visit to Traces. The Metrics exemplar link and both Logs views drive
 * the same two steps, so they drive them through here.
 * @param shardKey Shard the calling panel is reading, carried into the hand-off.
 */
const useOpenTrace = (shardKey: string): ((traceId: string) => void) => {
    const navigate = useNavigate();

    return (traceId: string): void => {
        writePendingTraceFilter({ shardKey, traceId });
        fireAndForget(navigate({ to: "/traces" }));
    };
};
export default useOpenTrace;

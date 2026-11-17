import type { ReactElement, Ref } from "react";
import { useEffect, useImperativeHandle } from "react";

import { usePaginatedQuery } from "../src/use-paginated-query";

interface FeedHandle {
    loaded: number;
    loadMore: (numberItems: number) => void;
}

const Feed = ({
    handleRef,
    numItems,
    onCommit,
}: {
    handleRef: Ref<FeedHandle>;
    numItems: number;
    /** Called after every commit, so the bench can prove a push reached the screen. */
    onCommit?: () => void;
}): ReactElement => {
    const result = usePaginatedQuery(
        { __lunoraRef: "messages:list" },
        { channelId: "general", filter: { authors: ["ada", "grace", "linus"], since: 1_700_000_000_000 } },
        { initialNumItems: numItems },
    );
    const loaded = result.results.length;
    // No dependency list: reports every commit.
    useEffect(() => {
        onCommit?.();
    });

    // The bench reads the feed from outside the tree through the ref, after commit.
    useImperativeHandle(handleRef, () => {
        return { loaded, loadMore: result.loadMore };
    });

    return <span>{loaded}</span>;
};

export default Feed;

import type { ReactElement, Ref } from "react";
import { useEffect, useImperativeHandle, useRef } from "react";

import { usePaginatedQuery } from "../src/use-paginated-query";

interface FeedHandle {
    /** Renders the feed has committed, so the bench can prove a push reached the screen. */
    readonly commits: number;
    loaded: number;
    loadMore: (numberItems: number) => void;
}

const Feed = ({ handleRef, numItems }: { handleRef: Ref<FeedHandle>; numItems: number }): ReactElement => {
    const result = usePaginatedQuery(
        { __lunoraRef: "messages:list" },
        { channelId: "general", filter: { authors: ["ada", "grace", "linus"], since: 1_700_000_000_000 } },
        { initialNumItems: numItems },
    );
    const loaded = result.results.length;
    const commits = useRef(0);

    // No dependency list: counts every commit.
    useEffect(() => {
        commits.current += 1;
    });

    // The bench reads the feed from outside the tree through the ref, after commit.
    useImperativeHandle(handleRef, () => {
        return {
            get commits(): number {
                return commits.current;
            },
            loaded,
            loadMore: result.loadMore,
        };
    });

    return <span>{loaded}</span>;
};

export default Feed;

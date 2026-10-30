import type { ReactElement, Ref } from "react";
import { useImperativeHandle } from "react";

import { usePaginatedQuery } from "../src/use-paginated-query";

interface FeedHandle {
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

    // The bench reads the feed from outside the tree through the ref, after commit.
    useImperativeHandle(handleRef, () => {
        return { loaded, loadMore: result.loadMore };
    });

    return <span>{loaded}</span>;
};

export default Feed;

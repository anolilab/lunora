import type { ReactElement } from "react";

import { usePaginatedQuery } from "../src/use-paginated-query";

interface FeedHandle {
    loaded: number;
    loadMore?: (numberItems: number) => void;
}

const Feed = ({ handle, numItems }: { handle: FeedHandle; numItems: number }): ReactElement => {
    const result = usePaginatedQuery(
        { __lunoraRef: "messages:list" },
        { channelId: "general", filter: { authors: ["ada", "grace", "linus"], since: 1_700_000_000_000 } },
        { initialNumItems: numItems },
    );

    // eslint-disable-next-line no-param-reassign -- the bench drives `loadMore` and reads the loaded count from outside the tree
    handle.loadMore = result.loadMore;
    // eslint-disable-next-line no-param-reassign -- see above
    handle.loaded = result.results.length;

    return <span>{handle.loaded}</span>;
};

export default Feed;

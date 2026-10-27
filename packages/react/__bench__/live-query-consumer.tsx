import type { FunctionReference } from "@lunora/client";
import type { ReactElement } from "react";

import useQuery from "../src/use-query";

const LIST: FunctionReference = { __lunoraRef: "todos:list" };
const ARGS = {};

/** One component reading the bench's live query. */
const Consumer = (): ReactElement => {
    const data = useQuery(LIST, ARGS) as unknown[] | undefined;

    return <span>{data?.length ?? -1}</span>;
};

export default Consumer;

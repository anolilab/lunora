import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { ShardInput } from "../../src/components/shard-input";
import { recordShard } from "../../src/lib/shard-history";

const Harness = (): React.ReactElement => {
    const [value, setValue] = useState("");

    return <ShardInput onChange={setValue} testId="x-shard" value={value} />;
};

describe("shardInput", () => {
    afterEach(() => {
        sessionStorage.clear();
    });

    it("renders the input with the panel's test id and no datalist when there's no history", () => {
        expect.assertions(2);

        render(<Harness />);

        expect(screen.getByTestId("x-shard")).toBeDefined();
        expect(screen.queryByTestId("x-shard-recents")).toBeNull();
    });

    it("offers recorded shards as datalist options", () => {
        expect.assertions(2);

        recordShard("room-7");
        recordShard("room-9");

        render(<Harness />);

        const datalist = screen.getByTestId("x-shard-recents");
        // <option>s inside a <datalist> are a native autocomplete source, not part of the
        // accessibility tree, so role/label queries can't reach them — direct DOM access is the
        // only way to assert their values.
        // eslint-disable-next-line testing-library/no-node-access -- datalist options aren't queryable via RTL
        const options = [...datalist.querySelectorAll("option")].map((option) => option.value);

        // Most-recent-first.
        expect(options).toEqual(["room-9", "room-7"]);
        // The input is wired to the datalist for native autocomplete.
        expect(screen.getByTestId("x-shard").getAttribute("list")).toBe(datalist.id);
    });

    it("propagates typed input through onChange", () => {
        expect.assertions(1);

        render(<Harness />);

        fireEvent.change(screen.getByTestId("x-shard"), { target: { value: "tenant-3" } });

        expect(screen.getByTestId<HTMLInputElement>("x-shard").value).toBe("tenant-3");
    });
});

import { LunoraError } from "@lunora/errors";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import ErrorAlert from "../../src/components/error-alert";

describe("error alert", () => {
    it("shows a coded error's cause explanation as its own line", () => {
        expect.assertions(1);

        render(<ErrorAlert error={new LunoraError("CONFLICT", "stale", { why: "row moved" })} testId="alert" />);

        expect(screen.getByText("row moved")).toBeDefined();
    });
});

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { OrphanedObjectsSection } from "../../../src/features/storage/file-orphans";
import { studioI18n } from "../../../src/i18n/i18n-context";

const t = (id: Parameters<typeof studioI18n._>[0], values?: Record<string, unknown>): string => studioI18n._(id, values);

const noop = (): void => {};

describe("orphanedObjectsSection", () => {
    it("does not claim every reference resolves when the scan was truncated", () => {
        expect.assertions(2);

        // A truncated enumeration checks nothing: the panel must say so rather than
        // render the strongest possible clean verdict over a check that never ran.
        render(<OrphanedObjectsSection busy={false} onCheck={noop} references={[]} t={t as never} truncated />);

        expect(screen.queryByTestId("fb-orphans-empty")).toBeNull();
        expect(screen.getByTestId("fb-orphans-truncated").textContent).toContain("could not be checked");
    });

    it("renders the all-clear only for a completed check that found none", () => {
        expect.assertions(2);

        render(<OrphanedObjectsSection busy={false} onCheck={noop} references={[]} t={t as never} truncated={false} />);

        expect(screen.getByTestId("fb-orphans-empty")).toBeDefined();
        expect(screen.queryByTestId("fb-orphans-truncated")).toBeNull();
    });

    it("renders neither verdict before the check has produced a result", () => {
        expect.assertions(2);

        render(<OrphanedObjectsSection busy={false} onCheck={noop} references={undefined} t={t as never} truncated={false} />);

        expect(screen.queryByTestId("fb-orphans-empty")).toBeNull();
        expect(screen.queryByTestId("fb-orphans-list")).toBeNull();
    });
});

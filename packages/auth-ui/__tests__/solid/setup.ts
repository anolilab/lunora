import "@testing-library/jest-dom/vitest";

// Solid Testing Library's auto-cleanup only activates with vitest `globals: true`,
// which this package keeps off — so unmount between tests by hand.
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest globals are disabled, so STL's auto-cleanup is inactive.
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// eslint-disable-next-line vitest/require-top-level-describe -- setup file; the cleanup hook is intentionally top-level.
afterEach(() => {
    cleanup();
});

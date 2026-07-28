import "@testing-library/jest-dom/vitest";

// Solid Testing Library's auto-cleanup only activates with vitest `globals: true`,
// which this package keeps off — so unmount between tests by hand.
import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

afterEach(() => {
    cleanup();
});

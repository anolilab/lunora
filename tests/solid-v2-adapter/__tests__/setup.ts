import "@testing-library/jest-dom/vitest";

import { cleanup } from "@solidjs/testing-library";
import { afterEach } from "vitest";

// Tear down rendered trees between tests so each render starts from a clean DOM.
// eslint-disable-next-line vitest/require-top-level-describe -- global setup file: a single cross-suite teardown hook belongs at the top level.
afterEach(() => {
    cleanup();
});

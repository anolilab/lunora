// Svelte Testing Library's auto-cleanup only activates with vitest `globals: true`,
// which this package keeps off — so unmount between tests by hand.
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest globals are disabled, so STL's auto-cleanup is inactive.
import { cleanup } from "@testing-library/svelte";
import { afterEach } from "vitest";

afterEach(() => {
    cleanup();
});

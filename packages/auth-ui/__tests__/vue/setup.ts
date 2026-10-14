// Vue Testing Library's auto-cleanup only activates with vitest `globals: true`,
// which this package keeps off — so unmount between tests by hand.
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest globals are disabled, so VTL's auto-cleanup is inactive.
import { cleanup } from "@testing-library/vue";
import { afterEach } from "vitest";

afterEach(() => {
    cleanup();
});

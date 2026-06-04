// React Testing Library's automatic cleanup only activates when the test
// runner's `afterEach` is exposed as a global (i.e. vitest `globals: true`).
// This project's vitest config keeps globals OFF, so RTL never registers its
// own afterEach and the manual hook below is load-bearing — removing it leaks
// the previous test's DOM into the next render and breaks isolation (verified:
// 15 tests fail without it).
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest globals are disabled, so RTL's auto-cleanup is inactive and this manual cleanup import + hook is required for test isolation.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// eslint-disable-next-line vitest/require-top-level-describe -- this is a global vitest setup file; the cleanup hook is intentionally top-level (no describe block) so it runs for every test suite.
afterEach(() => {
    cleanup();
});

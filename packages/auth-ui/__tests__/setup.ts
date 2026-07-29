// React Testing Library's automatic cleanup only activates when the runner's
// `afterEach` is a global (vitest `globals: true`). This project keeps globals
// OFF, so the manual cleanup hook below is load-bearing for test isolation —
// mirrors packages/react/__tests__/setup.ts.
// eslint-disable-next-line testing-library/no-manual-cleanup -- vitest globals are disabled, so RTL's auto-cleanup is inactive and this manual cleanup import + hook is required for test isolation.
import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

afterEach(() => {
    cleanup();
});

import type { TestHarness } from "../src/index";

/**
 * Every harness a suite opens, so one `afterEach(harnesses.closeAll)` releases
 * their in-memory SQLite handles even when a test fails before its own `close()`.
 */
const trackHarnesses = (): { closeAll: () => void; track: <T extends TestHarness>(harness: T) => T } => {
    const open: TestHarness[] = [];

    return {
        closeAll: () => {
            while (open.length > 0) {
                open.pop()?.close();
            }
        },
        track: (harness) => {
            open.push(harness);

            return harness;
        },
    };
};

export default trackHarnesses;

import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        environment: "jsdom",
        // Expose afterEach as a global so @testing-library/react registers its
        // automatic post-test cleanup (replaces the old manual cleanup() setup file).
        globals: true,
    },
});

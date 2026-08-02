import { defineConfig } from "vitest/config";

// Examples ship no coverage ratchet — this only guards the fractional-index
// algorithm in `lunora/ordering.ts`, which is the one piece of the demo that is
// not obvious by reading it.
export default defineConfig({
    test: {
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
    },
});

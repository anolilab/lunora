import { defineConfig } from "vitest/config";

// Examples ship no coverage ratchet. These tests run the example's real schema
// and procedures on the in-memory harness, so they fail when the example itself
// stops working — not just when a helper regresses.
export default defineConfig({
    test: {
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
    },
});

import { defineConfig } from "vitest/config";

// Examples ship no coverage ratchet — this guards the rules engine in
// `lunora/chess.ts`, which is the part of the demo that has to be right.
export default defineConfig({
    test: {
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
    },
});

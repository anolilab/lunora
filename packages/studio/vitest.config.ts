import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig({
    test: {
        environment: "jsdom",
        // Expose afterEach as a global so @testing-library/react registers its
        // automatic post-test cleanup (replaces the old manual cleanup() setup file).
        globals: true,
        // React Flow (the schema diagram) needs DOM-measurement APIs jsdom lacks.
        setupFiles: ["./__tests__/setup-reactflow.ts"],
    },
});

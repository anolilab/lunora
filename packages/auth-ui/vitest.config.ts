import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "jsdom",
            setupFiles: ["./__tests__/setup.ts"],
        },
    },
    // ratchet: framework-agnostic controllers are heavily covered; raise as the
    // React component tests fill in.
    { branches: 60 },
);

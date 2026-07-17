import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig(
    {
        test: {
            environment: "jsdom",
            setupFiles: ["./__tests__/setup.ts"],
        },
    },
    // ratchet: branches below the default floor; raise as coverage improves.
    { branches: 65 },
);

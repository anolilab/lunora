import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig({
    test: {
        environment: "node",
        include: ["__tests__/**/*.test.ts"],
    },
});

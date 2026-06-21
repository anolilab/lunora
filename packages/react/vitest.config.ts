import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig({
    test: {
        environment: "jsdom",
        setupFiles: ["./__tests__/setup.ts"],
    },
});

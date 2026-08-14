import { configDefaults } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

// `live-query`/`subscription`/`paginated-query`'s reactive-args tests bootstrap
// a real Angular `TestBed` (see `__tests__/setup.ts`), and `BrowserTestingModule`
// needs a DOM (`document`) — hence a separate `jsdom` project for just those
// three files. Everything else (including `server.test.ts`, which asserts
// `window`/`document` are `undefined`) stays on the package's original `node`
// project — switching the whole package to `jsdom` would give that test a real
// `document` and break its assertion.
const REACTIVE_ARGS_TESTS = ["__tests__/live-query.test.ts", "__tests__/subscription.test.ts", "__tests__/paginated-query.test.ts"];

// ratchet: all four below the default floor (voice-audio.ts is largely untested);
// raise as coverage improves.
export default getVitestConfig(
    {
        test: {
            projects: [
                {
                    test: {
                        environment: "node",
                        // A project's own `include`/`exclude` REPLACE vitest's built-in
                        // defaults rather than extending them. Omitting `include` here
                        // falls back to vitest's default glob resolved against the
                        // WORKSPACE root, not this package — collecting every
                        // `*.test.ts` in the monorepo. Omitting `configDefaults.exclude`
                        // from `exclude` would likewise stop excluding `node_modules`.
                        exclude: [...configDefaults.exclude, ...REACTIVE_ARGS_TESTS],
                        include: configDefaults.include,
                        name: "node",
                    },
                },
                {
                    test: {
                        environment: "jsdom",
                        include: REACTIVE_ARGS_TESTS,
                        name: "jsdom",
                        setupFiles: ["./__tests__/setup.ts"],
                    },
                },
            ],
        },
    },
    { branches: 64, functions: 79, lines: 79, statements: 79 },
);

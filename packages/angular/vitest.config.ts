import { configDefaults } from "vitest/config";

import { getVitestConfig } from "../../tools/get-vitest-config";

// Tests that bootstrap a real Angular `TestBed` (see `__tests__/setup.ts`) need
// a DOM, because `BrowserTestingModule` reaches for `document` — hence a
// separate `jsdom` project for them. Everything else (including
// `server.test.ts`, which asserts `window`/`document` are `undefined`) stays on
// the package's original `node` project: switching the whole package to `jsdom`
// would give that test a real `document` and break its assertion.
//
// Selected by a GLOB, not a filename list: a new DOM-needing test only has to
// be named `*.dom.test.ts` to land in the right project. A hard-coded list
// silently runs the next one under `node`, where `TestBed` fails for a reason
// that looks nothing like "wrong environment".
const DOM_TESTS = ["__tests__/**/*.dom.test.ts"];

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
                        exclude: [...configDefaults.exclude, ...DOM_TESTS],
                        include: configDefaults.include,
                        name: "node",
                    },
                },
                {
                    test: {
                        environment: "jsdom",
                        include: DOM_TESTS,
                        name: "jsdom",
                        setupFiles: ["./__tests__/setup.ts"],
                    },
                },
            ],
        },
    },
    { branches: 64, functions: 79, lines: 79, statements: 79 },
);

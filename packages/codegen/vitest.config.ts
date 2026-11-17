import { getVitestConfig } from "../../tools/get-vitest-config";

export default getVitestConfig({
    test: {
        environment: "node",
        // The heaviest suite in the repo, and the cost is structural: nearly
        // every spec builds a fresh ts-morph `Project`, and its FIRST
        // type-checker query parses and binds TypeScript's lib `.d.ts` files.
        // The specs cannot share a Project (they overwrite the same fixture
        // paths and assert on which declarations are visible), so this setup
        // file shares only the immutable lib SourceFiles across them.
        //
        // Twice the shared 30s ceiling, and NOT keyed on `process.env.CI` —
        // that is the mistake this replaces, the same one `getVitestConfig`
        // removed for every other package. The CI branch here read 60s while
        // the local branch read 10s, so this suite was the one project in the
        // repo running BELOW the shared default. In a full
        // `vis run test:coverage` sweep that produced one or two
        // `Test timed out in 10000ms` failures with zero assertion failures,
        // varying which specs lost the race — the signature of starvation, not
        // of a bug. Measured against the 10s ceiling it was not margin at all:
        // 13-20 specs ran over 5s and the slowest reached 9,459ms under a
        // sweep-shaped load and 10,625ms (a real failure) unloaded.
        //
        // A timeout only bounds how long a PASSING assertion waits, so the
        // headroom is free while the suite is healthy.
        hookTimeout: 60_000,
        setupFiles: ["./__tests__/share-lib-source-files.ts"],
        testTimeout: 60_000,
    },
});

import type { ControlPlaneDatabase } from "../../src/store";

/**
 * A {@link ControlPlaneDatabase} double answering `findMany` from per-table
 * pages, with any method overridable by a spy.
 *
 * Shared because six suites had grown their own copy of this exact signature
 * (`alert-sweep`, `uptime`, `sweeps`, `reconcile`, `rollout-guard`,
 * `alert-drain`) and one of them had drifted into a different shape for no
 * reason. A test double that six files re-derive is six chances to model the
 * store slightly wrong, which is how a suite ends up green against a fake that
 * behaves differently from the thing it stands in for.
 */
const fakeControlPlaneDb = (pages: Record<string, unknown[]>, spies: Partial<ControlPlaneDatabase> = {}): ControlPlaneDatabase => {
    return {
        delete: () => Promise.resolve(undefined),
        findMany: (table) => Promise.resolve({ page: pages[table] ?? [] }),
        insert: () => Promise.resolve("row_id"),
        patch: () => Promise.resolve(undefined),
        ...spies,
    };
};

export default fakeControlPlaneDb;

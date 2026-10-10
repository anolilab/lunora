/**
 * A build's execution between its two halves (`src/builds/runner-do.ts`): the
 * bundle, assets and manifest the build box produced, kept in the private
 * `RELEASES` bucket from the alarm that built it to the alarm that releases it,
 * and deleted once released. Up to 100 MiB, so never in Durable Object storage.
 */
import type { ReleaseBucket } from "../deploy/release-store";
import type { BuildExecution } from "./runner";

const executionKey = (buildId: string): string => `build-executions/${buildId}.json`;

export interface BuildExecutionStore {
    delete: (buildId: string) => Promise<void>;
    /** The stored execution, or `null` when there is none. */
    get: (buildId: string) => Promise<BuildExecution | null>;
    put: (buildId: string, execution: BuildExecution) => Promise<void>;
}

export const createBuildExecutionStore = (bucket: ReleaseBucket): BuildExecutionStore => {
    return {
        delete: (buildId) => bucket.delete(executionKey(buildId)),
        get: async (buildId) => {
            const object = await bucket.get(executionKey(buildId));

            return object === null ? null : (JSON.parse(await object.text()) as BuildExecution);
        },
        put: async (buildId, execution) => {
            await bucket.put(executionKey(buildId), JSON.stringify(execution));
        },
    };
};

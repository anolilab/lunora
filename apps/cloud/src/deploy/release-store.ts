/**
 * Stored releases. A project has exactly one dispatch-namespace script (its
 * alias), so a release is not a script — it is the validated deploy payload,
 * kept in the control plane's private `RELEASES` R2 bucket under its deployment
 * id. A rollback re-provisions one of these onto the stable script; the
 * teardown sweep deletes them once they fall out of the rollback window.
 *
 * Secrets are deliberately NOT stored: a re-provision resolves the project's
 * current secrets and mints its admin token from the target deployment's sealed
 * row, exactly like a fresh deploy.
 */
import type { AssetsUpload, DeployManifest } from "../provision-contract";

export interface StoredRelease {
    assets?: AssetsUpload;
    /** The prebuilt Worker module, base64 — as the deploy request carried it. */
    bundle: string;
    manifest: DeployManifest;
}

/** The slice of an R2 bucket binding the store uses. */
export interface ReleaseBucket {
    delete: (key: string) => Promise<void>;
    get: (key: string) => Promise<null | { text: () => Promise<string> }>;
    put: (key: string, value: string) => Promise<unknown>;
}

export interface ReleaseStore {
    delete: (deploymentId: string) => Promise<void>;
    /** The stored release, or `null` once it has been pruned. */
    get: (deploymentId: string) => Promise<null | StoredRelease>;
    put: (deploymentId: string, release: StoredRelease) => Promise<void>;
}

const releaseKey = (deploymentId: string): string => `releases/${deploymentId}.json`;

export const createReleaseStore = (bucket: ReleaseBucket): ReleaseStore => {
    return {
        delete: (deploymentId) => bucket.delete(releaseKey(deploymentId)),
        get: async (deploymentId) => {
            const object = await bucket.get(releaseKey(deploymentId));

            return object === null ? null : (JSON.parse(await object.text()) as StoredRelease);
        },
        put: async (deploymentId, release) => {
            await bucket.put(releaseKey(deploymentId), JSON.stringify(release));
        },
    };
};

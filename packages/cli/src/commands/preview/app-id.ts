import { randomUUID } from "node:crypto";

import { readManifest, recordManifestKey } from "@lunora/config/cloudflare";

const APP_ID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/iu;

/**
 * The project's id, kept in `package.json` under `lunora.appId` beside the other records the CLI keeps there.
 * Unlike `.lunora/project.json` it is committed, so a CI runner that has only a checkout finds the same id, and
 * unlike the Worker's name it survives a rename.
 */
const readAppId = (cwd: string): string | undefined => {
    const id = readManifest(cwd)?.lunora?.["appId"];

    // A UUID is the same id in either case, and records are keyed by one spelling: lowercase.
    return typeof id === "string" && APP_ID.test(id) ? id.toLowerCase() : undefined;
};

/** Write a new id into `package.json`, or return `undefined` when it cannot be written (no manifest, or a `lunora` that is not an object, or an id already there). */
const mintAppId = (cwd: string): string | undefined => {
    const manifest = readManifest(cwd);

    if (manifest === undefined || manifest.lunoraIsForeign || manifest.lunora?.["appId"] !== undefined) {
        return undefined;
    }

    const id = randomUUID();

    recordManifestKey(manifest, "appId", id);

    return readAppId(cwd) === id ? id : undefined;
};

export { mintAppId, readAppId };

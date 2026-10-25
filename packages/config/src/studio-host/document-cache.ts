import { devVariablesStamp } from "./admin-token";

/**
 * Cache a studio host's rendered document, re-rendering it whenever `.dev.vars`
 * under `root` changes. The document embeds the admin token, which is edited
 * mid-session (rotation, the first `lunora dev` run writing it), so a document
 * cached past such an edit would hand the studio a token the worker rejects.
 *
 * Every call costs one `stat` ({@link devVariablesStamp}); `render` runs on the
 * first call and again only after the stamp moves. The stamp is taken before
 * `render` reads the file, so a write landing between the two is seen as a
 * change on the next call rather than cached under the newer stamp.
 */
const createStudioDocumentCache = <T>(root: string, render: () => T): (() => T) => {
    let document: { value: T } | undefined;
    let documentStamp: string | undefined;

    return (): T => {
        const stamp = devVariablesStamp(root);

        if (document === undefined || stamp !== documentStamp) {
            documentStamp = stamp;
            document = { value: render() };
        }

        return document.value;
    };
};

export default createStudioDocumentCache;

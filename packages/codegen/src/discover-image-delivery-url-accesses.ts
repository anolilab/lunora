import type { CallExpression, Project } from "ts-morph";

import { calleeName, enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { collectCallRows, propertyInitializer } from "./discover-ast";
import type { ImageDeliveryUrlAccessIR } from "./ir";

/**
 * The IR row for a `buildImageDeliveryUrl({ key, … })` call whose `key` is
 * arg-derived and unscoped, or `undefined`.
 */
const imageDeliveryUrlAccessInCall = (call: CallExpression, relativePath: string): ImageDeliveryUrlAccessIR | undefined => {
    if (calleeName(call.getExpression()) !== "buildImageDeliveryUrl") {
        return undefined;
    }

    const options = call.getArguments()[0];

    if (!options) {
        return undefined;
    }

    const key = propertyInitializer(options, "key");

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a key like `` `${ctx.auth.userId}/…` ``
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (!key || !isArgumentDerived(key) || isScopedByContext(key)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber() };
};

/**
 * Discover `buildImageDeliveryUrl({ key, … })` calls (`@lunora/bindings/images`)
 * in `lunora/` whose `key` — the CDN transform's source image, an absolute URL
 * or an origin-relative key — is derived from the handler's `args` with no
 * server-side scoping — the `images_url_source_from_user_input` lint input.
 * `ctx.images.transform`/`info` take image bytes, never a URL, so they are not
 * sinks; only the `key` of `buildImageDeliveryUrl` accepts a URL-or-key source
 * and is inspected. A fixed literal `key`, or one scoped by a server-trusted `ctx.*`
 * value, is not recorded; only an arg-derived, unscoped `key` (directly, or
 * through one local `const` hop) reaches here. Only a direct object-literal
 * first argument is inspected, and one finding is produced per call.
 */
const discoverImageDeliveryUrlAccesses = (project: Project, lunoraDirectory: string): ImageDeliveryUrlAccessIR[] =>
    collectCallRows(project, lunoraDirectory, imageDeliveryUrlAccessInCall);

export default discoverImageDeliveryUrlAccesses;

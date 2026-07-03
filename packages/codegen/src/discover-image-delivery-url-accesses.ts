import type { CallExpression, Node as TsNode, Project, SourceFile } from "ts-morph";
import { Node, SyntaxKind } from "ts-morph";

import { enclosingExportName, isArgumentDerived, isScopedByContext } from "./argument-taint";
import { listLunoraSourceFiles, lunoraRelativePath } from "./discover-functions";
import type { ImageDeliveryUrlAccessIR } from "./ir";

/**
 * The simple callee name of a call expression — the trailing identifier for a
 * bare call (`buildImageDeliveryUrl(...)`) or a member call
 * (`images.buildImageDeliveryUrl(...)` → `buildImageDeliveryUrl`). Matched by
 * shape (an `import`-agnostic, fail-closed convention, the same one the other
 * feeders use), so a re-export or alias still resolves.
 */
const calleeName = (expression: TsNode): string | undefined => {
    if (Node.isIdentifier(expression)) {
        return expression.getText();
    }

    if (Node.isPropertyAccessExpression(expression)) {
        return expression.getName();
    }

    return undefined;
};

/**
 * The initializer of a `key` property on `options`, or `undefined` when
 * `options` is not a direct object-literal argument, or has no `key` property
 * assignment. A shorthand `{ key }` is deliberately skipped — keeps the check
 * single-hop/low-FP, matching the other sink feeders.
 */
const keyInitializer = (options: TsNode): TsNode | undefined => {
    if (!Node.isObjectLiteralExpression(options)) {
        return undefined;
    }

    const property = options.getProperty("key");

    return property && Node.isPropertyAssignment(property) ? property.getInitializer() : undefined;
};

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

    const key = keyInitializer(options);

    // Arg-derived (directly or through one local `const` hop) *and* not scoped by
    // a server-trusted `ctx.*` value — a key like `` `${ctx.auth.userId}/…` ``
    // references `ctx` and is treated as scoped, so it is not flagged.
    if (!key || !isArgumentDerived(key) || isScopedByContext(key)) {
        return undefined;
    }

    return { exportName: enclosingExportName(call), file: relativePath, line: call.getStartLineNumber() };
};

/** Arg-derived, unscoped `buildImageDeliveryUrl` `key` accesses in one source file. */
const imageDeliveryUrlAccessesInSourceFile = (sourceFile: SourceFile, relativePath: string): ImageDeliveryUrlAccessIR[] => {
    const found: ImageDeliveryUrlAccessIR[] = [];

    for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
        const access = imageDeliveryUrlAccessInCall(call, relativePath);

        if (access) {
            found.push(access);
        }
    }

    return found;
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
const discoverImageDeliveryUrlAccesses = (project: Project, lunoraDirectory: string): ImageDeliveryUrlAccessIR[] => {
    const accesses: ImageDeliveryUrlAccessIR[] = [];

    for (const filePath of listLunoraSourceFiles(lunoraDirectory)) {
        const sourceFile = project.getSourceFile(filePath) ?? project.addSourceFileAtPath(filePath);

        accesses.push(...imageDeliveryUrlAccessesInSourceFile(sourceFile, lunoraRelativePath(lunoraDirectory, filePath)));
    }

    return accesses;
};

export default discoverImageDeliveryUrlAccesses;

import type { CallExpression, Node as TsNode, Project } from "ts-morph";
import { Node } from "ts-morph";

import { enclosingExportName } from "./argument-taint";
import { collectCallRows } from "./discover-ast";
import type { StorageUploadIR } from "./ir";

/**
 * `ctx.storage.<bucket>.<method>` calls this feeder inspects, mapped to the
 * 0-based index of their options-object argument. Confirmed against the
 * `Storage` surface in `@lunora/storage`: `upload`/`store` take
 * `(key, body, options?: UploadOptions)`; `generateUploadUrl`/`getPresignedUrl`/
 * `getSignedUrl` take `(key, options?)`.
 */
const OPTIONS_ARGUMENT_INDEX = new Map<string, number>([
    ["generateUploadUrl", 1],
    ["getPresignedUrl", 1],
    ["getSignedUrl", 1],
    ["store", 2],
    ["upload", 2],
]);

/** The subset of {@link StorageUploadIR} a call-site reader can determine from the options argument alone. */
type StorageUploadEvidence = Pick<StorageUploadIR, "analyzable" | "expiresInSeconds" | "presentKeys">;

/** The numeric value of `node` when it is a plain numeric literal (e.g. `604800`), else `undefined`. Deliberately does not evaluate expressions (`60 * 60 * 24 * 7`) or references — only a literal is a reliable static signal. */
const numericLiteralValue = (node: TsNode | undefined): number | undefined => (node && Node.isNumericLiteral(node) ? Number(node.getText()) : undefined);

/**
 * Read an options-object argument into the present-keys set plus, when present,
 * an `expiresInSeconds` numeric literal. A spread (`{ ...opts }`) makes the
 * literal opaque — keys could be contributed elsewhere — so the absent-key
 * lints must skip it rather than flag on a key the merged object may well set.
 * A completely **absent** argument (the common case — `ctx.storage.upload(key,
 * body)` with no third argument) is the strongest possible "no options" signal
 * and is treated as analyzable with an empty key set, unlike a non-object-literal
 * argument (a variable/call result), which is opaque and not analyzable.
 */
const readOptionsArgument = (argument: TsNode | undefined): StorageUploadEvidence => {
    if (argument === undefined) {
        return { analyzable: true, presentKeys: [] };
    }

    if (!Node.isObjectLiteralExpression(argument)) {
        return { analyzable: false, presentKeys: [] };
    }

    const presentKeys: string[] = [];
    let expiresInSeconds: number | undefined;
    let hasSpread = false;

    for (const property of argument.getProperties()) {
        if (Node.isSpreadAssignment(property)) {
            hasSpread = true;

            continue;
        }

        if (Node.isPropertyAssignment(property)) {
            const name = property.getName();

            presentKeys.push(name);

            if (name === "expiresInSeconds") {
                expiresInSeconds = numericLiteralValue(property.getInitializer());
            }

            continue;
        }

        // A shorthand (`{ contentType }`) or method (`contentType() {}`) still declares the key.
        if (Node.isShorthandPropertyAssignment(property) || Node.isMethodDeclaration(property)) {
            presentKeys.push(property.getName());
        }
    }

    return { analyzable: !hasSpread, expiresInSeconds, presentKeys };
};

/**
 * The tracked method name + its options-argument index when `node` is a
 * `ctx.storage.<bucket>.<method>` member access, else `undefined`. Matched by
 * shape (a property access whose name is a tracked method and whose receiver
 * text is `ctx.storage` or `ctx.storage.<bucket>`) — the same `import`-agnostic,
 * fail-closed convention the other feeders use, so a re-export or alias still
 * resolves.
 */
const storageUploadMethod = (node: TsNode): { method: string; optionsIndex: number } | undefined => {
    if (!Node.isPropertyAccessExpression(node)) {
        return undefined;
    }

    const method = node.getName();
    const optionsIndex = OPTIONS_ARGUMENT_INDEX.get(method);

    if (optionsIndex === undefined) {
        return undefined;
    }

    const receiver = node.getExpression().getText();

    return receiver === "ctx.storage" || receiver.startsWith("ctx.storage.") ? { method, optionsIndex } : undefined;
};

/** The IR row for a tracked `ctx.storage.<bucket>.<method>(...)` call, or `undefined`. */
const storageUploadInCall = (call: CallExpression, relativePath: string): StorageUploadIR | undefined => {
    const matched = storageUploadMethod(call.getExpression());

    if (matched === undefined) {
        return undefined;
    }

    return {
        exportName: enclosingExportName(call),
        file: relativePath,
        line: call.getStartLineNumber(),
        method: matched.method as StorageUploadIR["method"],
        ...readOptionsArgument(call.getArguments()[matched.optionsIndex]),
    };
};

/**
 * Discover `ctx.storage.<bucket>.<method>(...)` upload/signing calls in
 * `lunora/` — the shared input for the storage config-hygiene security lints
 * (`storage_upload_without_content_type_allowlist`, `storage_upload_without_max_size`,
 * `storage_generate_upload_url_no_content_type_pin`, `storage_presigned_url_for_private_content`).
 * Tracks `upload`/`store` (the `UploadOptions` guards — `allowedContentTypes` /
 * `maxSize`), `generateUploadUrl` (the signed-PUT `contentType` pin), and
 * `getPresignedUrl`/`getSignedUrl` (the `expiresInSeconds` ceiling). Records
 * which options-object keys are present (and, for the two URL signers, a
 * statically-known `expiresInSeconds` literal) so each lint can decide what an
 * absent key or a near-ceiling literal means; a non-analyzable options argument
 * (a variable, call result, or a spread) is never used to infer absence.
 */
const discoverStorageUploads = (project: Project, lunoraDirectory: string): StorageUploadIR[] => collectCallRows(project, lunoraDirectory, storageUploadInCall);

export default discoverStorageUploads;

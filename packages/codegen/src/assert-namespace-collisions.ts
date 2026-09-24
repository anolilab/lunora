import { LunoraError } from "@lunora/errors";

import sanitizeNamespace from "./paths";

/**
 * Reject two function files whose sanitized namespaces collide.
 *
 * `sanitizeNamespace` maps every non-identifier character to `_`, so
 * `lunora/a-b.ts` and `lunora/a_b.ts` both become `a_b` — and the api/server
 * emitters group by FILE path, not by namespace, so both groups are rendered and
 * `_generated/api.ts` gets a duplicate `a_b` key. That surfaces as TS2300
 * ("Duplicate identifier") inside generated code the user did not write, and the
 * runtime dispatch key `a_b:<fn>` is ambiguous besides. Every other collision
 * class in codegen (workflow/agent names, the reserved `agents:` and
 * `sandbox:invoke` paths) has a pinpointed diagnostic; this one had none.
 *
 * The `/index` collapse is part of the same namespace function, so
 * `lunora/foo/index.ts` and `lunora/foo.ts` are caught here too — both are
 * `foo`.
 *
 * Called once per emitted namespace SPACE, not once per run: `api.*` (functions
 * + mutators) and `httpStreams.*` (`.stream()` routes) are separate objects, so
 * a function file and a route file may share a namespace without colliding —
 * but two route files may not. Checking the streaming routes was missing
 * entirely, and `renderHttpStreamsRef` groups them by the same `sanitizeNamespace`,
 * so `feed-a.ts` + `feed_a.ts` emitted the key twice into both the
 * `HttpStreamsRef` interface (TS2300) and its object literal (TS1117).
 * @param filePaths every file path contributing to one namespace space (relative to the lunora dir, no extension).
 * @param surface which emitted namespace space is being checked — names the failure in the diagnostic.
 * @throws when two distinct paths sanitize to one namespace.
 */
const assertNoNamespaceCollisions = (filePaths: Iterable<string>, surface: "api" | "http-stream" = "api"): void => {
    const byNamespace = new Map<string, string>();

    for (const filePath of filePaths) {
        const namespace = sanitizeNamespace(filePath);
        const previous = byNamespace.get(namespace);

        if (previous === undefined) {
            byNamespace.set(namespace, filePath);

            continue;
        }

        if (previous !== filePath) {
            // "INTERNAL" is the code every other codegen-time collision uses
            // (`agents:*` / `sandbox:invoke` in `emit.ts`) — the error catalog has
            // no codegen-authoring code, and adding one is `@lunora/errors`' call.
            const consequence =
                surface === "api"
                    ? `the generated api.ts would declare "${namespace}" twice and the dispatch key "${namespace}:<fn>" would be ambiguous`
                    : `the generated api.ts would declare "${namespace}" twice in HttpStreamsRef and again in the httpStreams object literal`;

            throw new LunoraError(
                "INTERNAL",
                `@lunora/codegen: "${previous}" and "${filePath}" both map to the ${surface} namespace "${namespace}" — ${consequence}. Rename one file so the two differ by more than a non-identifier character (\`-\`, \`.\`, \`/\` and \`_\` all sanitize to \`_\`).`,
                { status: 500 },
            );
        }
    }
};

export default assertNoNamespaceCollisions;

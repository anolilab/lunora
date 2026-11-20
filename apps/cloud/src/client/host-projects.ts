/**
 * Which projects sit on which host — the Boxes and Cloudflare accounts tabs list them.
 *
 * Its own module, not part of `target-capabilities.ts`, so those two tabs do not import
 * `provision-contract.ts`: that module evaluates `@lunora/config/celld` at load, whose
 * entry also pulls the `node:fs` config projection into the browser graph, and the Vite
 * dev client throws on it. This helper needs none of that.
 */

/** The names of the projects placed on each host (a box, a connected account), by the host's id. */
export const projectNamesByHost = (projects: ReadonlyArray<{ name: string; placementRef?: string }> | undefined): Map<string, string[]> => {
    const byHost = new Map<string, string[]>();

    for (const project of projects ?? []) {
        if (project.placementRef !== undefined) {
            byHost.set(project.placementRef, [...(byHost.get(project.placementRef) ?? []), project.name]);
        }
    }

    return byHost;
};

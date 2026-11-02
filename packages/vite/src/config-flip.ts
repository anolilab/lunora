import { resolve } from "node:path";

import { PROJECT_CONFIG_FILENAMES } from "@lunora/codegen";

/**
 * Whether saving `file` regenerates `_generated/` because it flipped `codegen.lazyFunctions`.
 *
 * A save of any project-root config candidate (created, changed or deleted) moves the content fingerprint, and that restarts the
 * server, whose first codegen reads the new value. Regenerating here as well would race that restart. Before the startup baseline
 * settles, no restart follows, so the flip regenerates. A nearer config, which the restart does not cover, regenerates on a flip.
 */
const configFlipRegenerates = (input: { baselineSettled: boolean; file: string; flipped: boolean; projectRoot: string }): boolean => {
    const rootCandidate = PROJECT_CONFIG_FILENAMES.some((name) => resolve(input.projectRoot, name) === input.file);

    return input.flipped && (!rootCandidate || !input.baselineSettled);
};

export default configFlipRegenerates;

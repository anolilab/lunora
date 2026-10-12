import { defineWorkflow } from "@lunora/workflow";

import type { RestoreParameters } from "./privacy";
import { privacyWorkflows } from "./privacy";

/** Built from the package's durable handlers. Each step is memoised, so a restart resumes where it stopped. */
export const privacyExport = defineWorkflow<{ requestId: string }>({
    handler: privacyWorkflows.exportHandler,
    limits: { steps: 25_000 },
    name: "privacy-export",
});

/** Sleeps through the 14-day grace, then erases. A cancel during the grace stops it. */
export const privacyErasure = defineWorkflow<{ requestId: string }>({
    handler: privacyWorkflows.erasureHandler,
    limits: { steps: 25_000 },
    name: "privacy-erasure",
});

/** Re-erases the subjects a point-in-time restore brought back. Started by the operator's `restorePrivacyErasures`. */
export const privacyRestore = defineWorkflow<RestoreParameters>({
    handler: privacyWorkflows.restoreHandler,
    limits: { steps: 25_000 },
    name: "privacy-restore",
});

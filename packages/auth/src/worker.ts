// The names the generated `_generated/app.ts` loads with `import()` on the first event. Imported
// straight from their modules, not through `./index`: a bundler wraps every module the dynamic
// import reaches in a lazy-init function, so routing this through the barrel would make any static
// `import { … } from "@lunora/auth"` elsewhere in the app initialise the whole barrel at startup.
export { lunoraD1Adapter } from "./adapter";
export { createAuthAdmin } from "./admin";
export { createAuthAuditReader } from "./audit";
export { createAuth } from "./create-auth";
export { authDiscoveryPathsFor, handleAuthDiscoveryRequest } from "./discovery";
export { createDoAuthWiring } from "./do-wiring";
export { handleAuthRequest } from "./handler";
export { d1Executor } from "./sql-store";

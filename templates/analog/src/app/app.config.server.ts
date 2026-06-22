import type { ApplicationConfig } from "@angular/core";
import { mergeApplicationConfig } from "@angular/core";
import { provideServerRendering } from "@angular/platform-server";

import { appConfig } from "./app.config";

/**
 * Server (SSR) application config — the browser config plus Angular's
 * server-rendering providers. Used by `main.server.ts` when Nitro renders a page.
 */
const serverConfig: ApplicationConfig = {
    providers: [provideServerRendering()],
};

export const config = mergeApplicationConfig(appConfig, serverConfig);

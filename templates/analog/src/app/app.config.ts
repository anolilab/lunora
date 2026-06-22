import { provideFileRouter } from "@analogjs/router";
import { provideHttpClient, withFetch } from "@angular/common/http";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";

/**
 * Browser application config. `provideFileRouter()` wires AnalogJS's file-based
 * routing (`src/app/pages/**`), and `provideClientHydration()` enables SSR
 * hydration so the Nitro-rendered HTML is reused on the client.
 */
export const appConfig: ApplicationConfig = {
    providers: [provideFileRouter(), provideHttpClient(withFetch()), provideClientHydration()],
};

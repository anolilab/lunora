import { provideFileRouter } from "@analogjs/router";
import { provideHttpClient, withFetch } from "@angular/common/http";
import type { ApplicationConfig } from "@angular/core";
import { provideClientHydration } from "@angular/platform-browser";
import { provideLunora } from "@lunora/angular";

/**
 * Browser application config. `provideFileRouter()` wires AnalogJS's file-based
 * routing (`src/app/pages/**`), `provideClientHydration()` enables SSR hydration
 * so the Nitro-rendered HTML is reused on the client, and `provideLunora()` wires
 * the Lunora client into the injector (same-origin by default — the single-worker
 * deploy where `/_lunora/ws` loops back into this app's own worker; pass
 * `{ url }` for a split deploy).
 */
export const appConfig: ApplicationConfig = {
    providers: [provideFileRouter(), provideHttpClient(withFetch()), provideClientHydration(), provideLunora()],
};

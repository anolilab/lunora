import "zone.js/node";
import { enableProdMode } from "@angular/core";
import { bootstrapApplication } from "@angular/platform-browser";
import { renderApplication } from "@angular/platform-server";
import { provideServerContext } from "@analogjs/router/server";
import type { ServerContext } from "@analogjs/router/tokens";

import { AppComponent } from "./app/app.component";
import { config } from "./app/app.config.server";

if (import.meta.env.PROD) {
    enableProdMode();
}

export function bootstrap(options: any) {
    return bootstrapApplication(AppComponent, config, options);
}

export default async function render(url: string, document: string, serverContext: ServerContext) {
    const html = await renderApplication(bootstrap, {
        document,
        url,
        platformProviders: [provideServerContext(serverContext)],
    });
    return html;
}

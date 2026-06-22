import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./app/app.component";
import { config } from "./app/app.config.server";

/** Server (SSR) entry — AnalogJS/Nitro calls this default export to render a page. */
const bootstrap = (): Promise<unknown> => bootstrapApplication(AppComponent, config);

export default bootstrap;

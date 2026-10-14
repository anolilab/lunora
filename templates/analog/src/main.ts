import { bootstrapApplication } from "@angular/platform-browser";

import { AppComponent } from "./app/app.component";
import { appConfig } from "./app/app.config";

/** Browser entry — bootstraps the standalone root component with the file router. */
bootstrapApplication(AppComponent, appConfig).catch((error: unknown) => {
    // eslint-disable-next-line no-console -- surface bootstrap failures in the browser console
    console.error(error);
});

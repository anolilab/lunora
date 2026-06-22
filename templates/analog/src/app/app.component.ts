import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

/**
 * Root component — just the router outlet. AnalogJS file-based routes under
 * `src/app/pages/` render into it (`pages/index.page.ts` → `/`).
 */
@Component({
    imports: [RouterOutlet],
    selector: "app-root",
    standalone: true,
    template: `<router-outlet />`,
})
export class AppComponent {}

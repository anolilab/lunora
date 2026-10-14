/**
 * Angular `TestBed` bootstrap — zoneless, no `zone.js`.
 *
 * The reactive-args resubscribe tests (`live-query`, `subscription`,
 * `paginated-query`) need a genuinely bootstrapped Angular environment:
 * `effect()` reads `ChangeDetectionScheduler` off its injector, and only
 * `bootstrapApplication`/`TestBed` ever register that — never a hand-built
 * `Injector.create(...)`, verified empirically while investigating plan 340
 * (a bare environment injector, even with `provideZonelessChangeDetection()`
 * passed to it directly, still throws `NG0201: No provider found for
 * ChangeDetectionSchedulerImpl`). `BrowserTestingModule` needs a DOM
 * (`document`), hence this package's `jsdom` test environment.
 *
 * `provideZonelessChangeDetection()` itself is supplied per-suite via
 * `TestBed.configureTestingModule(...)` — this file only wires the platform,
 * once, before any suite runs.
 */
import { getTestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";

// eslint-disable-next-line vitest/require-hook -- TestBed bootstrap runs once at module load, before any suite.
getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting());

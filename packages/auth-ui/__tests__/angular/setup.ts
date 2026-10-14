/**
 * Angular TestBed bootstrap.
 *
 * `@angular/compiler` is imported for its side effect: it installs the JIT
 * compiler, which is what lets these standalone, inline-template components be
 * compiled at runtime instead of needing the AOT build plugin.
 */
import "@angular/compiler";
import "zone.js";
import "zone.js/testing";

import { getTestBed } from "@angular/core/testing";
import { BrowserTestingModule, platformBrowserTesting } from "@angular/platform-browser/testing";

// eslint-disable-next-line vitest/require-hook -- TestBed bootstrap runs once at module load, before any suite.
getTestBed().initTestEnvironment(BrowserTestingModule, platformBrowserTesting(), { errorOnUnknownElements: true, errorOnUnknownProperties: true });

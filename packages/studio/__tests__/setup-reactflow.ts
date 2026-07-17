// React Flow measures the DOM (node sizes, the viewport, zoom transforms) via
// APIs jsdom doesn't implement: `ResizeObserver`, `DOMMatrixReadOnly`, element
// offset sizes, `SVGElement.getBBox`, `Element.getAnimations`, and `matchMedia`.
// Without these the `<ReactFlow>` canvas throws on render (or, for the `fitView`
// zoom transition, asynchronously after the test). These stubs give it just
// enough to mount and lay nodes out; they don't emulate real layout (every box
// reports a 1px-ish size), which is fine — our tests assert the rendered nodes /
// columns / handles, not pixel geometry.
//
// Referenced from `vitest.config.ts` `setupFiles`, so it runs once per test file
// before any test. Adapted from React Flow's documented testing setup.

import { configure } from "@testing-library/react";

/* eslint-disable vitest/require-hook -- a setupFile installs global stubs at module scope before any test runs; there is no hook context */

// Lazy-loaded Studio panels (advisors, migrations, …) can take longer than
// Testing Library's 1s default to mount under CI's parallel-test contention
// (and v8-coverage instrumentation), so give `findBy`/`waitFor` more headroom
// there — mirroring the repo's CI vitest-timeout bump. Local runs keep the
// snappy default for fast feedback.
configure({ asyncUtilTimeout: process.env["CI"] === "true" ? 5000 : 1000 });

/* eslint-disable class-methods-use-this -- no-op DOM stub: ResizeObserver methods intentionally do nothing */
class ResizeObserverStub {
    public disconnect(): void {}

    public observe(): void {}

    public unobserve(): void {}
}
/* eslint-enable class-methods-use-this */

class DOMMatrixReadOnlyStub {
    public readonly m22: number;

    public constructor(transform?: string) {
        const scale = transform?.match(/scale\(([\d.]+)\)/)?.[1];

        this.m22 = scale === undefined ? 1 : Number.parseFloat(scale);
    }
}

const globalRef = globalThis as unknown as Record<string, unknown>;

globalRef["ResizeObserver"] = ResizeObserverStub;
globalRef["DOMMatrixReadOnly"] = DOMMatrixReadOnlyStub;

Object.defineProperties(globalThis.HTMLElement.prototype, {
    offsetHeight: {
        configurable: true,
        get(this: HTMLElement): number {
            return Number.parseFloat(this.style.height) || 1;
        },
    },
    offsetWidth: {
        configurable: true,
        get(this: HTMLElement): number {
            return Number.parseFloat(this.style.width) || 1;
        },
    },
});

// jsdom's SVGElement lacks getBBox; the stub's return shape is all React Flow reads.
if (!("getBBox" in globalThis.SVGElement.prototype)) {
    (globalThis.SVGElement.prototype as any).getBBox = (): { height: number; width: number; x: number; y: number } => {
        return { height: 0, width: 0, x: 0, y: 0 };
    };
}

// `fitView` runs a d3-zoom transition that queries the viewport's running
// animations; without this it throws asynchronously after the rendering test.
if (typeof globalThis.Element.prototype.getAnimations !== "function") {
    (globalThis.Element.prototype as any).getAnimations = (): Animation[] => [];
}

if (typeof globalThis.matchMedia !== "function") {
    globalRef["matchMedia"] = (query: string): MediaQueryList => {
        return {
            addEventListener: () => {},
            addListener: () => {},
            dispatchEvent: () => false,
            matches: false,
            media: query,
            onchange: null,
            removeEventListener: () => {},
            removeListener: () => {},
        };
    };
}

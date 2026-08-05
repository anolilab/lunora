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
    /**
     * Kept and invoked on `observe`. A real `ResizeObserver` delivers an initial
     * measurement as soon as it observes, and the data grid relies on exactly
     * that callback to size its column window — a stub that dropped the callback
     * silently disabled the measurement under test while passing.
     */
    private readonly callback: (entries: unknown[], observer: unknown) => void;

    public constructor(callback: (entries: unknown[], observer: unknown) => void) {
        this.callback = callback;
    }

    public disconnect(): void {}

    public observe(target: Element): void {
        // A real observer delivers `(entries, observer)` — react-virtual reads
        // `entries[0].borderBoxSize`, so an argument-less call throws. jsdom
        // does no layout, so a real observer would report the element's inline
        // style sizes; recharts' `ResponsiveContainer` warns when the measured
        // size is 0×0, flooding the suite with "should be greater than 0"
        // stderr. Report a non-zero fallback so chart consumers stay quiet —
        // the elements already carry `min-h-0` Tailwind classes that produce
        // zero, and the data grid treats a non-zero viewport the same as any
        // other (it just needs *a* size to virtualize against).
        const size = { blockSize: 100, inlineSize: 100 };

        this.callback([{ borderBoxSize: [size], contentBoxSize: [size], contentRect: { height: 100, width: 100 }, target }], this);
    }

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

// jsdom's `Element.prototype.scrollIntoView` is absent — the operation console
// calls it to reveal the entry an error surface pointed at. jsdom also leaves
// `window.scrollTo`/`scrollBy`/`scroll` as not-implemented stubs that flood
// stderr with "Not implemented: Window's scrollTo() method" each time
// @tanstack/react-virtual's scroll-sync effect runs — 60+ lines per CI run
// that drown real signal. Replace both with plain no-ops so the suite stays
// quiet; the studio's scroll behaviour wasn't real under jsdom anyway.
if (typeof globalThis.Element.prototype.scrollIntoView !== "function") {
    (globalThis.Element.prototype as any).scrollIntoView = (): void => {};
}

if (typeof globalThis.Element.prototype.scrollTo !== "function") {
    (globalThis.Element.prototype as any).scrollTo = (): void => {};
}

for (const methodName of ["scroll", "scrollBy", "scrollTo"] as const) {
    Object.defineProperty(globalThis, methodName, {
        configurable: true,
        value: (): void => {},
        writable: true,
    });
}

// jsdom reports every `getBoundingClientRect` as 0×0 (no layout engine), which
// makes recharts' `ResponsiveContainer` warn "The width(0) and height(0) of
// chart should be greater than 0" on every chart mount — over 50 stderr lines
// per run. The studio's chart tests assert on rendered output, not pixel
// geometry, so a consistent non-zero rect keeps them quiet without changing
// what the tests actually verify.
// Capture the native implementation before overwriting it. A plain method
// reference (`proto.getBoundingClientRect`) trips `@typescript-eslint/unbound
// -method`, and `.bind()` fixes lint but changes the receiver to the prototype
// object itself, which jsdom's native implementation rejects (`… called on an
// object that is not a valid instance of Element`). Reading the property
// descriptor keeps the original `this`-forwarding `.call` semantics intact.
const originalGetBoundingClientRect = ((): ((this: Element) => DOMRect) => {
    let descriptor: PropertyDescriptor | undefined;
    let cursor: unknown = globalThis.Element.prototype;

    while (descriptor === undefined && typeof cursor === "object" && cursor !== null) {
        descriptor = Object.getOwnPropertyDescriptor(cursor, "getBoundingClientRect");
        cursor = Object.getPrototypeOf(cursor);
    }

    return descriptor?.value as (this: Element) => DOMRect;
})();

(globalThis.Element.prototype as any).getBoundingClientRect = function getBoundingClientRect(): DOMRect {
    // Delegate to the original for the window-like/foreign-element cases that
    // already have a real implementation (none under jsdom, but defensive).
    const original = originalGetBoundingClientRect.call(this);

    if (original.width === 0 && original.height === 0) {
        return {
            bottom: 100,
            height: 100,
            left: 0,
            right: 100,
            toJSON: (): unknown => {
                return { bottom: 100, height: 100, left: 0, right: 100, top: 0, width: 100 };
            },
            top: 0,
            width: 100,
            x: 0,
            y: 0,
        };
    }

    return original;
};

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

// jsdom can't actually navigate across documents, so a `history.back()` past
// the start of the in-memory session (kv-browser, table-editor view mirroring)
// emits "Not implemented: navigation to another Document" as a `jsdomError`.
// The Studio suite never needs that navigation to actually happen, but the
// warning floods stderr — intercept the virtual console and drop just that
// message; everything else still forwards so genuine jsdom errors surface.
const virtualConsole = (
    globalThis as unknown as {
        [key: string]: unknown;
    }
)["_virtualConsole"] as
    | {
          emit: (type: string, ...args: unknown[]) => boolean;
          on: (type: string, listener: (...args: unknown[]) => void) => void;
          removeAllListeners: (type: string) => unknown;
      }
    | undefined;

if (virtualConsole !== undefined) {
    const originalEmit = virtualConsole.emit.bind(virtualConsole);

    virtualConsole.emit = (type: string, ...args: unknown[]): boolean => {
        if (type === "jsdomError" && args[0] instanceof Error && args[0].message === "Not implemented: navigation to another Document") {
            return false;
        }

        return originalEmit(type, ...args);
    };
}

// `culori` (pulled in transitively by the remocn-ui registry helpers) doesn't
// expose its bundled types under `moduleResolution: bundler` — its package
// exports map omits a `types` condition for the entry the resolver picks. We
// only touch it through remocn's typed wrappers, so declare the surface those
// wrappers use.
declare module "culori" {
    export interface Rgb {
        mode: "rgb";
        r: number;
        g: number;
        b: number;
        alpha?: number;
    }
    export interface Oklch {
        mode: "oklch";
        l: number;
        c: number;
        h?: number;
        alpha?: number;
    }
    export function converter(mode: string): (color: unknown) => any;
    export function parse(color: string): any;
    export function formatRgb(color: unknown): string;
    export function clampChroma(color: unknown, mode?: string, rgbGamut?: string): any;
    export function interpolate(colors: unknown[], mode?: string): (t: number) => any;
}

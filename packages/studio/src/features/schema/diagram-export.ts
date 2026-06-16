/**
 * Pure utilities for exporting the schema diagram as PNG, SVG, or JSON.
 *
 * PNG/SVG export uses `html-to-image` (React Flow's recommended approach) with
 * `getNodesBounds` + `getViewportForBounds` to frame every node at a
 * predictable resolution regardless of the current pan/zoom. JSON export
 * serialises the current React Flow `nodes`/`edges` graph to a blob.
 *
 * The download helper (`triggerDownload`) is kept separate so tests can verify
 * the serializer without touching `document.body`.
 */

import type { Edge, Node } from "@xyflow/react";
import { getNodesBounds, getViewportForBounds } from "@xyflow/react";
import { toBlob, toSvg } from "html-to-image";

/** Target canvas size for PNG/SVG rasterisation (in logical pixels). */
const IMAGE_WIDTH = 1920;
const IMAGE_HEIGHT = 1080;

/** Padding around the node bounds, so edges don't clip at the frame edge. */
const IMAGE_PADDING = 32;

/**
 * The serialised form of the graph written to the JSON export.
 * Identical in structure to the React Flow node/edge arrays so the file is
 * re-importable by any React Flow consumer.
 */
interface DiagramJsonExport {
    edges: Edge[];
    exportedAt: string;
    nodes: Node[];
}

/**
 * Append a temporary anchor element to the document, click it, then
 * remove it. Works in every modern browser; no server round-trip required.
 */
const triggerDownload = (href: string, filename: string): void => {
    const link = globalThis.document.createElement("a");

    link.href = href;
    link.download = filename;
    globalThis.document.body.append(link);
    link.click();
    link.remove();
};

/**
 * Serialise `nodes` + `edges` to a JSON blob and trigger a browser download.
 * Pure function: does not depend on any DOM element beyond `document.body`.
 */
const exportDiagramAsJson = (nodes: Node[], edges: Edge[], filename = "schema-diagram.json"): void => {
    const payload: DiagramJsonExport = {
        edges,
        exportedAt: new Date().toISOString(),
        nodes,
    };
    const json = JSON.stringify(payload, undefined, 2);
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only file download; this file is studio-side only
    const url = globalThis.URL.createObjectURL(new globalThis.Blob([json], { type: "application/json" }));

    triggerDownload(url, filename);
    // Defer revocation off the click's synchronous turn so the browser has a chance
    // to start consuming the blob before the URL is released. Revoking in the same
    // tick as the click can abort the download in some browsers because the fetch of
    // the blob URL is initiated asynchronously. A brief setTimeout is the standard
    // approach (used by FileSaver.js and the MDN download-blob pattern).
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only; pairs with createObjectURL above
    globalThis.setTimeout(() => {
        globalThis.URL.revokeObjectURL(url);
    }, 0);
};

/**
 * Compute the viewport transform that centres all `nodes` inside a
 * `width x height` canvas with `padding` on every side.
 *
 * Wraps `getNodesBounds` + `getViewportForBounds` from `@xyflow/react` so the
 * call site just passes the current node list and the desired output size.
 */
const viewportForExport = (nodes: Node[], width: number, height: number, padding: number): { transform: [number, number, number]; zoom: number } => {
    const bounds = getNodesBounds(nodes);
    const { x, y, zoom } = getViewportForBounds(bounds, width, height, 0.1, 2, padding);

    return { transform: [x, y, zoom], zoom };
};

/**
 * Export the React Flow diagram as a PNG image and trigger a browser download.
 * @param viewportElement The `.react-flow__viewport` element.
 * @param nodes Current React Flow node list (from `useNodes()`).
 * @param filename Suggested filename (default `schema-diagram.png`).
 */
const exportDiagramAsPng = async (viewportElement: HTMLElement, nodes: Node[], filename = "schema-diagram.png"): Promise<void> => {
    const { transform } = viewportForExport(nodes, IMAGE_WIDTH, IMAGE_HEIGHT, IMAGE_PADDING);
    const [tx, ty, scale] = transform;

    const blob = await toBlob(viewportElement, {
        backgroundColor: "#ffffff",
        height: IMAGE_HEIGHT,
        style: {
            transform: `translate(${tx.toString()}px, ${ty.toString()}px) scale(${scale.toString()})`,
            transformOrigin: "top left",
            width: `${IMAGE_WIDTH.toString()}px`,
        },
        width: IMAGE_WIDTH,
    });

    if (blob === null) {
        throw new Error("html-to-image produced no blob");
    }

    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only file download; this file is studio-side only
    const url = globalThis.URL.createObjectURL(blob);

    triggerDownload(url, filename);
    // Defer revocation off the click's synchronous turn — same reason as the JSON
    // path above: some browsers fetch blob: URLs asynchronously after the anchor
    // click returns, so revoking in the same tick can abort the download.
    // eslint-disable-next-line n/no-unsupported-features/node-builtins -- browser-only; pairs with createObjectURL above
    globalThis.setTimeout(() => {
        globalThis.URL.revokeObjectURL(url);
    }, 0);
};

/**
 * Export the React Flow diagram as an SVG and trigger a browser download.
 * @param viewportElement The `.react-flow__viewport` element.
 * @param nodes Current React Flow node list (from `useNodes()`).
 * @param filename Suggested filename (default `schema-diagram.svg`).
 */
const exportDiagramAsSvg = async (viewportElement: HTMLElement, nodes: Node[], filename = "schema-diagram.svg"): Promise<void> => {
    const { transform } = viewportForExport(nodes, IMAGE_WIDTH, IMAGE_HEIGHT, IMAGE_PADDING);
    const [tx, ty, scale] = transform;

    const svgDataUrl = await toSvg(viewportElement, {
        backgroundColor: "#ffffff",
        height: IMAGE_HEIGHT,
        style: {
            transform: `translate(${tx.toString()}px, ${ty.toString()}px) scale(${scale.toString()})`,
            transformOrigin: "top left",
            width: `${IMAGE_WIDTH.toString()}px`,
        },
        width: IMAGE_WIDTH,
    });

    triggerDownload(svgDataUrl, filename);
};

export type { DiagramJsonExport };
export { exportDiagramAsJson, exportDiagramAsPng, exportDiagramAsSvg, viewportForExport };

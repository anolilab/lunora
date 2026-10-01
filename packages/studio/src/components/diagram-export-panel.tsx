"use client";

import { Download01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/react";
import { Panel, useNodes, useReactFlow } from "@xyflow/react";
import type { ReactElement, RefObject } from "react";
import { useState } from "react";

import { exportDiagramAsJson, exportDiagramAsPng, exportDiagramAsSvg } from "../features/schema/diagram-export";
import { useT } from "../i18n/i18n-context";
import { fireAndForget } from "../lib/internal";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "./ui/dropdown-menu";

/**
 * Export toolbar rendered inside the React Flow canvas via `Panel`.
 *
 * Must be mounted as a child of `ReactFlow` so it can call `useReactFlow()`
 * and `useNodes()`. The PNG/SVG handlers locate the `.react-flow__viewport`
 * element through a ref on the wrapping container and pass it to `html-to-image`.
 */
interface DiagramExportPanelProps {
    /** The element wrapping the canvas; its `.react-flow__viewport` is what PNG/SVG rasterise. */
    readonly containerRef: RefObject<HTMLElement | null>;
    /** Download filename without extension, e.g. `architecture`. */
    readonly filenameBase: string;
    readonly testIdPrefix: string;
}

const DiagramExportPanel = ({ containerRef, filenameBase, testIdPrefix }: DiagramExportPanelProps): ReactElement => {
    const t = useT();
    const nodes = useNodes();
    const { getEdges } = useReactFlow();
    const [exporting, setExporting] = useState<"json" | "png" | "svg" | null>(null);

    const handlePng = async (): Promise<void> => {
        const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");

        if (!viewport) {
            return;
        }

        setExporting("png");

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the export must clear its in-flight marker on the throw path, and adding a catch just to satisfy the compiler would swallow the failure
        try {
            await exportDiagramAsPng(viewport, nodes, `${filenameBase}.png`);
        } finally {
            setExporting(null);
        }
    };

    const handleSvg = async (): Promise<void> => {
        const viewport = containerRef.current?.querySelector<HTMLElement>(".react-flow__viewport");

        if (!viewport) {
            return;
        }

        setExporting("svg");

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the export must clear its in-flight marker on the throw path, and adding a catch just to satisfy the compiler would swallow the failure
        try {
            await exportDiagramAsSvg(viewport, nodes, `${filenameBase}.svg`);
        } finally {
            setExporting(null);
        }
    };

    const handleJson = (): void => {
        setExporting("json");

        // react-doctor-disable-next-line react-hooks-js/todo -- React Compiler cannot lower `try` without `catch`; the export must clear its in-flight marker on the throw path, and adding a catch just to satisfy the compiler would swallow the failure
        try {
            exportDiagramAsJson(nodes, getEdges(), `${filenameBase}.json`);
        } finally {
            setExporting(null);
        }
    };

    const onClickPng = (): void => {
        fireAndForget(handlePng());
    };

    const onClickSvg = (): void => {
        fireAndForget(handleSvg());
    };

    return (
        <Panel position="top-right">
            <DropdownMenu>
                <DropdownMenuTrigger
                    className="group/button inline-flex shrink-0 cursor-pointer items-center justify-center gap-1 rounded-md border border-border bg-background px-2 text-xs font-medium whitespace-nowrap hover:bg-muted disabled:pointer-events-none disabled:opacity-50"
                    data-testid={`${testIdPrefix}-export-trigger`}
                    disabled={exporting !== null}
                >
                    <HugeiconsIcon className="size-3.5" icon={Download01Icon} strokeWidth={2} />
                    {t("Export")}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                    <DropdownMenuItem data-testid={`${testIdPrefix}-export-png`} disabled={exporting !== null} onClick={onClickPng}>
                        {t("PNG")}
                    </DropdownMenuItem>
                    <DropdownMenuItem data-testid={`${testIdPrefix}-export-svg`} disabled={exporting !== null} onClick={onClickSvg}>
                        {t("SVG")}
                    </DropdownMenuItem>
                    <DropdownMenuItem data-testid={`${testIdPrefix}-export-json`} disabled={exporting !== null} onClick={handleJson}>
                        {t("JSON")}
                    </DropdownMenuItem>
                </DropdownMenuContent>
            </DropdownMenu>
        </Panel>
    );
};

export type { DiagramExportPanelProps };
export default DiagramExportPanel;

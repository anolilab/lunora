import type { ReactElement } from "react";

import { useT } from "../../i18n/i18n-context";
import type { SqlTabStripModel } from "./hooks/use-sql-editor-tabs";
import TabButton from "./sql-tab-button";
import { MAX_TABS } from "./sql-tabs";

/**
 * The editor's tab strip and its right-click menu: switch, rename, close, and the
 * bulk close-others / close-to-right / close-all operations with their unsaved-work
 * discard confirm.
 *
 * Takes the sixteen model fields it renders as one `Pick`, rather than sixteen
 * loose props that would restate the hook's shape without decoupling anything. The
 * `Pick` is the point: handing over the whole `SqlEditorTabsModel` would also hand
 * the strip the panel's write path into tab state (`patchActiveTab`,
 * `patchActiveOutput`, `unlinkQuery`) and the active tab's run output, none of which
 * it renders. `onSelect` stays separate because switching tabs also closes the
 * editor's completion popover, which is the panel's concern, not the strip's.
 */
const SqlTabStrip = ({ model, onSelect }: { readonly model: SqlTabStripModel; readonly onSelect: (id: string) => void }): ReactElement => {
    const t = useT();
    const {
        activeTab,
        addEditorTab,
        cancelBulk,
        closeEditorTab,
        closeTabMenu,
        confirmBulk,
        menuStyle,
        onBackdropContextMenu,
        onCloseAll,
        onCloseOthers,
        onCloseToRight,
        openTabMenu,
        pendingBulk,
        renameTab,
        tabMenu,
        tabs,
    } = model;

    return (
        <>
            {/* Editor tab strip. */}
            <div className="flex shrink-0 items-stretch overflow-x-auto border-b border-border bg-muted/30" data-testid="sql-tab-strip" role="tablist">
                {tabs.map((each) => (
                    <TabButton
                        active={each.id === activeTab.id}
                        canClose={tabs.length > 1}
                        key={each.id}
                        onClose={closeEditorTab}
                        onMenu={openTabMenu}
                        onRename={renameTab}
                        onSelect={onSelect}
                        tab={each}
                    />
                ))}
                <button
                    aria-label={t("New tab")}
                    className="flex size-8 shrink-0 items-center justify-center text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
                    data-testid="sql-tab-add"
                    disabled={tabs.length >= MAX_TABS}
                    onClick={addEditorTab}
                    title={t("New tab")}
                    type="button"
                >
                    <svg
                        aria-hidden="true"
                        className="size-4"
                        fill="none"
                        stroke="currentColor"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        strokeWidth={1.7}
                        viewBox="0 0 24 24"
                    >
                        <path d="M12 5v14M5 12h14" />
                    </svg>
                </button>
            </div>

            {/* Right-click tab context menu: bulk close operations. */}
            {tabMenu !== null && (
                <>
                    <div
                        className="fixed inset-0 z-40"
                        data-testid="sql-tab-menu-backdrop"
                        onClick={closeTabMenu}
                        onContextMenu={onBackdropContextMenu}
                        role="presentation"
                    />
                    <div
                        className="fixed z-50 min-w-44 rounded-md border border-border bg-popover py-1 text-popover-foreground shadow-md"
                        data-testid="sql-tab-menu"
                        role="menu"
                        style={menuStyle}
                    >
                        {pendingBulk === null ? (
                            <>
                                <button
                                    className="flex w-full items-center px-3 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
                                    data-testid="sql-tab-menu-close-others"
                                    disabled={tabs.length <= 1}
                                    onClick={onCloseOthers}
                                    role="menuitem"
                                    type="button"
                                >
                                    {t("Close other tabs")}
                                </button>
                                <button
                                    className="flex w-full items-center px-3 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent disabled:pointer-events-none disabled:opacity-40"
                                    data-testid="sql-tab-menu-close-right"
                                    disabled={tabs.findIndex((each) => each.id === tabMenu.id) >= tabs.length - 1}
                                    onClick={onCloseToRight}
                                    role="menuitem"
                                    type="button"
                                >
                                    {t("Close tabs to the right")}
                                </button>
                                <button
                                    className="flex w-full items-center px-3 py-1.5 text-start text-xs outline-none hover:bg-accent focus-visible:bg-accent"
                                    data-testid="sql-tab-menu-close-all"
                                    onClick={onCloseAll}
                                    role="menuitem"
                                    type="button"
                                >
                                    {t("Close all tabs")}
                                </button>
                            </>
                        ) : (
                            // Discard confirm: the chosen bulk close would drop a tab with unsaved work.
                            <div className="px-3 py-1.5" data-testid="sql-tab-menu-confirm">
                                <p className="pb-1.5 text-xs text-muted-foreground">{t("Discard unsaved tabs?")}</p>
                                <div className="flex items-center gap-1.5">
                                    <button
                                        className="rounded px-2 py-1 text-xs font-medium text-destructive outline-none hover:bg-destructive/10 focus-visible:bg-destructive/10"
                                        data-testid="sql-tab-menu-confirm-discard"
                                        onClick={confirmBulk}
                                        type="button"
                                    >
                                        {t("Discard")}
                                    </button>
                                    <button
                                        className="rounded px-2 py-1 text-xs text-muted-foreground outline-none hover:bg-accent focus-visible:bg-accent"
                                        data-testid="sql-tab-menu-confirm-cancel"
                                        onClick={cancelBulk}
                                        type="button"
                                    >
                                        {t("Cancel")}
                                    </button>
                                </div>
                            </div>
                        )}
                    </div>
                </>
            )}
        </>
    );
};

export { SqlTabStrip };

import type { Doc } from "../../lunora/_generated/dataModel.js";

export type Task = Doc<"tasks">;

export type Status = Task["status"];

/** The board's columns, left to right. */
export const COLUMNS = ["todo", "in-progress", "done", "archived"] as const satisfies readonly Status[];

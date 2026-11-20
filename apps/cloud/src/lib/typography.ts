/**
 * The caps-locked label voice: small, medium weight, tracked, uppercase. Column
 * headers, form labels, section headings and counts all use this one role.
 *
 * It lives under `src/lib` rather than the client section modules so the shadcn
 * primitives in `components/ui` can import it without reaching into the app layer.
 * The bare `&lt;label>` rule in `client/theme.css` repeats the same values because CSS
 * cannot import TypeScript; change both together.
 */
export const COLUMN_LABEL = "text-[11px] font-medium tracking-[0.08em] uppercase";

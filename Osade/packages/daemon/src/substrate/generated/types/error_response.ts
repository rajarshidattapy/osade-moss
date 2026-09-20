/**
 * GENERATED — DO NOT EDIT.
 *
 * Source: vendor/runtime/0.8.2-p20/api-schema.json
 * Regenerate: pnpm substrate:codegen
 *
 * OSADE.md §4.1 — the pinned schema is the only codegen source. Never hand-write a substrate
 * method name, and never derive one from backend/.
 */

/* eslint-disable */

export interface ErrorResponse {
  error: ErrorBody;
  id: string;
}
export interface ErrorBody {
  code: string;
  message: string;
}

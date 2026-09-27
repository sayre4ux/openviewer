// A value that could name a resource in CSS or SVG: url(), image(), image-set(), cross-fade(),
// element(), @import, or any backslash escape that could spell one of those. Shared by the export
// sanitizer and the math and diagram sanitizers, so all three drop the same things.
// DECISION: a module of its own rather than an export of src/export/render.ts, so the math and
// diagram chunks don't pull in the export code.
export const loads = /url\s*\(|image\s*\(|image-set|cross-fade|element\s*\(|@import|expression\s*\(|\\/i;

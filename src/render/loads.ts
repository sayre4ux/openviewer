// A value that could name a resource in CSS or SVG: url(), image(), image-set(), cross-fade(),
// element(), @import, or any backslash escape that could spell one of those. Shared by the export
// sanitizer and the math and diagram sanitizers, so all three drop the same things.
export const loads = /url\s*\(|image\s*\(|image-set|cross-fade|element\s*\(|@import|expression\s*\(|\\/i;

import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Quiet light palette for code inside fences, close to what Typora ships with Newsprint.
// Only code tags are styled; Markdown structure is styled by the live-preview layer.
const codeStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword], color: "#708" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a11" },
  { tag: [t.number, t.bool, t.atom], color: "#164" },
  { tag: [t.tagName, t.angleBracket], color: "#170" },
  { tag: t.attributeName, color: "#00c" },
  { tag: [t.lineComment, t.blockComment], color: "#a50" },
  { tag: [t.typeName, t.className], color: "#085" },
  { tag: t.definition(t.variableName), color: "#00f" },
]);

export const codeHighlight = syntaxHighlighting(codeStyle);

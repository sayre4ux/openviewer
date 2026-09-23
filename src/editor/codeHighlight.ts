import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

// Dark palette for the code-block card, after Codex's lavender keywords. Only code tags are
// styled; Markdown structure is styled by the live-preview layer.
const codeStyle = HighlightStyle.define([
  { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.definitionKeyword, t.modifier], color: "#b392f0" },
  { tag: [t.string, t.special(t.string), t.regexp], color: "#a5d6a7" },
  { tag: [t.number, t.bool, t.atom], color: "#f2b880" },
  { tag: [t.tagName, t.angleBracket], color: "#8fb8f0" },
  { tag: t.attributeName, color: "#b392f0" },
  { tag: [t.lineComment, t.blockComment], color: "#6f7680", fontStyle: "italic" },
  { tag: [t.typeName, t.className], color: "#e6c07b" },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: "#8fb8f0" },
]);

export const codeHighlight = syntaxHighlighting(codeStyle);

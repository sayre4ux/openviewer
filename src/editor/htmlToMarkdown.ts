type RenderContext = {
  bold: boolean;
  italic: boolean;
  strike: boolean;
  tableCell: boolean;
};

const ignoredTags = new Set(["script", "style", "meta", "link", "title", "head"]);
const rawIgnoredTags = new Set(["script", "style", "title"]);
const pasteSourcePrefix = "data-ov-paste-";
const blockTags = new Set([
  "p", "div", "blockquote", "pre", "ul", "ol", "table", "hr",
  "h1", "h2", "h3", "h4", "h5", "h6", "address", "article", "aside",
  "details", "dialog", "dl", "dt", "dd", "fieldset", "figcaption", "figure",
  "footer", "form", "header", "main", "nav", "section", "summary",
]);
const emptyContext: RenderContext = { bold: false, italic: false, strike: false, tableCell: false };

function tagName(element: Element): string {
  return (element.localName || element.nodeName).toLowerCase();
}

function ignored(element: Element): boolean {
  const tag = tagName(element);
  return ignoredTags.has(tag) || tag.includes(":");
}

function styleValue(element: Element, name: string): string {
  const style = element.getAttribute("style") ?? "";
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0 || declaration.slice(0, colon).trim().toLowerCase() !== name) continue;
    return declaration.slice(colon + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase();
  }
  return "";
}

function boldWeight(value: string): boolean {
  return value === "bold" || value === "bolder" || (Number.parseFloat(value) >= 600);
}

function isBoldB(element: Element): boolean {
  const weight = styleValue(element, "font-weight");
  return weight ? boldWeight(weight) : true;
}

function spanStyles(element: Element) {
  const weight = styleValue(element, "font-weight");
  const decoration = `${styleValue(element, "text-decoration")} ${styleValue(element, "text-decoration-line")}`;
  return {
    bold: boldWeight(weight),
    italic: styleValue(element, "font-style") === "italic",
    strike: /(?:^|\s)line-through(?:\s|$)/.test(decoration),
  };
}

function normalizeSpace(text: string): string {
  return text.replace(/\u00a0/g, " ").replace(/[\s\u00a0]+/g, " ");
}

function filteredStyle(style: string): string {
  const kept = new Map<string, string>();
  for (const declaration of style.split(";")) {
    const colon = declaration.indexOf(":");
    if (colon < 0) continue;
    const name = declaration.slice(0, colon).trim().toLowerCase();
    const value = declaration.slice(colon + 1).replace(/\s*!important\s*$/i, "").trim().toLowerCase();
    if (name === "font-weight" && /^(?:normal|bold|bolder|lighter|inherit|initial|unset|\d{1,4}(?:\.\d+)?)$/.test(value)) {
      kept.set(name, value);
    } else if (name === "font-style" && value === "italic") {
      kept.set(name, value);
    } else if ((name === "text-decoration" || name === "text-decoration-line") && /(?:^|\s)line-through(?:\s|$)/.test(value)) {
      kept.set(name, "line-through");
    } else if (name === "text-align" && ["left", "center", "right"].includes(value)) {
      kept.set(name, value);
    }
  }
  return Array.from(kept, ([name, value]) => `${name}:${value}`).join(";");
}

function findTagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === "\"" || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return html.length;
}

function sanitizeStartTag(token: string, tag: string): string {
  const opening = /^<([a-z][a-z\d:-]*)/i.exec(token);
  if (!opening) return token;
  let result = `<${opening[1]}`;
  let cursor = opening[0].length;
  while (cursor < token.length) {
    const spaceStart = cursor;
    while (/\s/.test(token[cursor] ?? "")) cursor++;
    const leading = token.slice(spaceStart, cursor);
    if (token[cursor] === ">" || token[cursor] === "/") {
      result += leading + token.slice(cursor);
      break;
    }

    const attrStart = cursor;
    while (cursor < token.length && !/[\s=/>]/.test(token[cursor])) cursor++;
    if (cursor === attrStart) {
      result += leading + token[cursor++];
      continue;
    }
    const nameEnd = cursor;
    const name = token.slice(attrStart, nameEnd);
    let value: string | null = null;
    while (/\s/.test(token[cursor] ?? "")) cursor++;
    if (token[cursor] === "=") {
      cursor++;
      while (/\s/.test(token[cursor] ?? "")) cursor++;
      const quote = token[cursor] === "\"" || token[cursor] === "'" ? token[cursor++] : "";
      const valueStart = cursor;
      if (quote) {
        while (cursor < token.length && token[cursor] !== quote) cursor++;
        value = token.slice(valueStart, cursor);
        if (cursor < token.length) cursor++;
      } else {
        while (cursor < token.length && !/[\s>]/.test(token[cursor])) cursor++;
        value = token.slice(valueStart, cursor);
      }
    }
    const suffix = token.slice(nameEnd, cursor);
    const lowerName = name.toLowerCase();
    if (lowerName === "style") {
      const style = filteredStyle(value ?? "");
      if (style) result += `${leading}style="${style}"`;
    } else {
      const safeAttribute = (tag === "img" && ["src", "alt"].includes(lowerName)) ||
        (tag === "a" && lowerName === "href") ||
        (["pre", "code"].includes(tag) && lowerName === "class") ||
        (tag === "ol" && lowerName === "start") ||
        (["td", "th"].includes(tag) && lowerName === "align") ||
        (tag === "input" && ["type", "checked"].includes(lowerName));
      if (tag === "img" && lowerName === "src") result += leading + `${pasteSourcePrefix}src` + suffix;
      else if (safeAttribute) result += leading + name + suffix;
    }
  }
  return result;
}

function neutralizeResources(html: string): string {
  // The inert document is never attached; keep resource-bearing attributes inert during parsing too.
  const safe: string[] = [];
  let cursor = 0;
  while (cursor < html.length) {
    if (html.startsWith("<!--", cursor)) {
      const end = html.indexOf("-->", cursor + 4);
      const next = end < 0 ? html.length : end + 3;
      safe.push(html.slice(cursor, next));
      cursor = next;
      continue;
    }
    if (html[cursor] !== "<") {
      const next = html.indexOf("<", cursor);
      safe.push(html.slice(cursor, next < 0 ? html.length : next));
      cursor = next < 0 ? html.length : next;
      continue;
    }
    const opening = /^<([a-z][a-z\d:-]*)\b/i.exec(html.slice(cursor));
    if (!opening) {
      safe.push(html[cursor++]);
      continue;
    }
    const tag = opening[1].toLowerCase();
    const end = findTagEnd(html, cursor + opening[0].length);
    if (end === html.length && html[end - 1] !== ">") {
      safe.push(html.slice(cursor));
      break;
    }
    if (ignoredTags.has(tag)) {
      if (rawIgnoredTags.has(tag)) {
        const closing = new RegExp(`<\\/${tag}\\s*>`, "ig");
        closing.lastIndex = end;
        const match = closing.exec(html);
        cursor = match ? closing.lastIndex : html.length;
      } else {
        cursor = end;
      }
      continue;
    }
    const token = html.slice(cursor, end);
    safe.push(sanitizeStartTag(token, tag));
    cursor = end;
  }
  return safe.join("");
}

function escapeText(text: string): string {
  const escaped = normalizeSpace(text).replace(/[\\`*_\[\]]/g, "\\$&");
  return escaped.replace(/(^|\n)( {0,3})(?=(?:#{1,6}(?:[ \t]|$)|>|[-+](?:[ \t]|$)|\d+\.(?:[ \t]|$)))/g, "$1$2\\");
}

function rawText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (ignored(element)) return "";
  return Array.from(element.childNodes, rawText).join("");
}

function visibleText(node: Node): string {
  if (node.nodeType === Node.TEXT_NODE) return node.nodeValue ?? "";
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (ignored(element)) return "";
  const tag = tagName(element);
  if (tag === "img") return element.getAttribute("alt") ?? "";
  if (tag === "br") return " ";
  const children = Array.from(element.childNodes, visibleText).join("");
  return blockTags.has(tag) || /^h[1-6]$/.test(tag) || ["li", "tr", "td", "th"].includes(tag)
    ? ` ${children} `
    : children;
}

function hasFormatting(node: Node): boolean {
  if (node.nodeType !== Node.ELEMENT_NODE) return false;
  const element = node as Element;
  if (ignored(element)) return false;
  const tag = tagName(element);
  if (["strong", "em", "i", "s", "del", "strike", "code", "pre", "a", "img", "ul", "ol", "li", "blockquote", "table", "hr"].includes(tag)) return true;
  if (/^h[1-6]$/.test(tag) || (tag === "b" && isBoldB(element))) return true;
  if (tag === "span" && Object.values(spanStyles(element)).some(Boolean)) return true;
  return Array.from(element.childNodes).some(hasFormatting);
}

function wrap(content: string, marker: string): string {
  const leading = content.match(/^\s*/)?.[0] ?? "";
  const innerAndTrailing = content.slice(leading.length);
  const trailing = innerAndTrailing.match(/\s*$/)?.[0] ?? "";
  const inner = innerAndTrailing.slice(0, innerAndTrailing.length - trailing.length);
  return inner ? `${leading}${marker}${inner}${marker}${trailing}` : content;
}

function longestRun(text: string, char: "`" | "~"): number {
  let longest = 0;
  let current = 0;
  for (const value of text) {
    current = value === char ? current + 1 : 0;
    longest = Math.max(longest, current);
  }
  return longest;
}

function inlineCode(element: Element): string {
  const content = normalizeSpace(rawText(element));
  if (!content) return "";
  const fence = "`".repeat(longestRun(content, "`") + 1);
  const padding = /^\s|\s$|^`|`$/.test(content) ? " " : "";
  return `${fence}${padding}${content}${padding}${fence}`;
}

function languageInfo(pre: Element): string {
  const elements = [pre, ...Array.from(pre.querySelectorAll("code"))];
  for (const element of elements) {
    for (const name of Array.from(element.classList)) {
      const match = /^(?:language|lang)-([\w.+-]+)$/i.exec(name);
      if (match) return match[1];
    }
  }
  return "";
}

function fencedCode(pre: Element): string {
  const content = rawText(pre).replace(/\r\n?/g, "\n");
  const fence = "`".repeat(Math.max(3, longestRun(content, "`") + 1));
  const info = languageInfo(pre);
  return `${fence}${info ? info : ""}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`;
}

function safeDestination(value: string, kind: "link" | "image"): string | null {
  const destination = value.trim();
  if (!destination) return null;
  if (/[\u0000-\u001f\u007f]/.test(destination)) return null;
  const scheme = /^([a-z][a-z\d+.-]*):/i.exec(destination)?.[1]?.toLowerCase();
  if (scheme) {
    if (scheme === "http" || scheme === "https" || (kind === "link" && scheme === "mailto")) {
      // Allowed web and mail destinations are retained.
    } else if (kind === "image" && scheme === "data" && destination.length <= 1024) {
      // Bound inline data so clipboard HTML cannot inject an unbounded payload.
    } else {
      return null;
    }
  }
  return destination;
}

function markdownDestination(destination: string): string {
  const safe = destination.replace(/</g, "%3C").replace(/>/g, "%3E");
  return /[\s()]/.test(safe) ? `<${safe}>` : safe;
}

function directCells(row: Element): Element[] {
  return Array.from(row.children).filter((child) => ["td", "th"].includes(tagName(child)));
}

function alignment(cell: Element | undefined): "left" | "center" | "right" | "" {
  if (!cell) return "";
  const value = (cell.getAttribute("align") || styleValue(cell, "text-align")).trim().toLowerCase();
  return value === "left" || value === "center" || value === "right" ? value : "";
}

function renderTable(table: Element): string {
  const rows = Array.from(table.querySelectorAll("tr")).filter((row) => row.closest("table") === table);
  const cellsByRow = rows.map(directCells);
  const headIndex = rows.findIndex((row) => tagName(row.parentElement!) === "thead");
  const selectedHead = headIndex >= 0 ? headIndex : (rows.length > 0 ? 0 : -1);
  let columnCount = 1;
  for (const cells of cellsByRow) columnCount = Math.max(columnCount, cells.length);
  const renderCell = (cell: Element | undefined) => {
    const rendered = cell ? renderInlineChildren(cell, { ...emptyContext, tableCell: true }) : "";
    return rendered.replace(/[\s\u00a0]+/g, " ").trim().replace(/\|/g, "\\|");
  };
  const header = rows.length === 1
    ? Array.from({ length: columnCount }, () => "")
    : Array.from({ length: columnCount }, (_, column) => renderCell(cellsByRow[selectedHead]?.[column]));
  const alignments = Array.from({ length: columnCount }, (_, column) => alignment(cellsByRow[selectedHead]?.[column]));
  const delimiter = alignments.map((align) => align === "left" ? ":---" : align === "center" ? ":---:" : align === "right" ? "---:" : "---");
  const formatRow = (cells: string[]) => `| ${cells.join(" | ")} |`;
  const bodyRows = cellsByRow.flatMap((cells, index) => {
    if (rows.length === 1) return [cells];
    return index === selectedHead ? [] : [cells];
  });
  const body = bodyRows.map((cells) => formatRow(Array.from({ length: columnCount }, (_, column) => renderCell(cells[column]))));
  return [formatRow(header), formatRow(delimiter), ...body].join("\n");
}

function renderList(list: Element, indent: number, context: RenderContext): string {
  const ordered = tagName(list) === "ol";
  const parsedStart = Number.parseInt(list.getAttribute("start") ?? "1", 10);
  let number = Number.isFinite(parsedStart) ? parsedStart : 1;
  const lines: string[] = [];
  const items = Array.from(list.children).filter((child) => tagName(child) === "li");
  for (const item of items) {
    const marker = ordered ? `${number++}. ` : "- ";
    const childNodes = Array.from(item.childNodes);
    let checkbox = "";
    const firstContent = childNodes.findIndex((node) => !(node.nodeType === Node.TEXT_NODE && !(node.nodeValue ?? "").trim()));
    if (firstContent >= 0 && childNodes[firstContent].nodeType === Node.ELEMENT_NODE) {
      const first = childNodes[firstContent] as Element;
      if (tagName(first) === "input" && (first.getAttribute("type") ?? "").toLowerCase() === "checkbox") {
        checkbox = first.hasAttribute("checked") ? "[x] " : "[ ] ";
        childNodes.splice(firstContent, 1);
      }
    }
    const nestedLists = childNodes.filter((node): node is Element => node.nodeType === Node.ELEMENT_NODE && ["ul", "ol"].includes(tagName(node as Element)));
    const bodyNodes = childNodes.filter((node) => !nestedLists.includes(node as Element));
    const content = renderChildren(bodyNodes, context).trim();
    const continuation = " ".repeat(indent + marker.length);
    const contentLines = content.split("\n");
    const firstLine = contentLines.shift() ?? "";
    let itemText = `${" ".repeat(indent)}${marker}${checkbox}${firstLine}`;
    if (contentLines.length) itemText += `\n${contentLines.map((line) => line ? `${continuation}${line}` : "").join("\n")}`;
    lines.push(itemText.trimEnd());
    for (const nested of nestedLists) lines.push(renderList(nested, indent + marker.length, context));
  }
  return lines.join("\n");
}

function renderInlineChildren(element: Element, context: RenderContext): string {
  return renderChildren(Array.from(element.childNodes), context, true);
}

function renderChildren(nodes: Node[], context: RenderContext, inlineOnly = false): string {
  if (inlineOnly) return nodes.map((node) => renderNode(node, context)).join("");
  const blocks: string[] = [];
  let inline = "";
  const flush = () => {
    const text = inline.trim();
    if (text) blocks.push(text);
    inline = "";
  };
  for (const node of nodes) {
    if (node.nodeType === Node.ELEMENT_NODE && blockTags.has(tagName(node as Element))) {
      flush();
      const rendered = renderNode(node, context).trim();
      if (rendered) blocks.push(rendered);
    } else {
      inline += renderNode(node, context);
    }
  }
  flush();
  return blocks.join("\n\n");
}

function renderNode(node: Node, context: RenderContext): string {
  if (node.nodeType === Node.TEXT_NODE) return escapeText(node.nodeValue ?? "");
  if (node.nodeType !== Node.ELEMENT_NODE) return "";
  const element = node as Element;
  if (ignored(element)) return "";
  const tag = tagName(element);

  if (tag === "pre") return fencedCode(element);
  if (tag === "code") return inlineCode(element);
  if (tag === "br") return context.tableCell ? " " : "\\\n";
  if (tag === "img") {
    const alt = escapeText(element.getAttribute("alt") ?? "");
    const source = safeDestination(element.getAttribute(`${pasteSourcePrefix}src`) ?? "", "image");
    return source === null ? alt : `![${alt}](${markdownDestination(source)})`;
  }
  if (tag === "a") {
    const content = renderInlineChildren(element, context);
    const href = safeDestination(element.getAttribute("href") ?? "", "link");
    if (href === null) return content;
    const text = normalizeSpace(visibleText(element)).trim();
    if (/^https?:\/\//i.test(href) && text === href) return `<${href}>`;
    return `[${content}](${markdownDestination(href)})`;
  }
  if (tag === "h1" || tag === "h2" || tag === "h3" || tag === "h4" || tag === "h5" || tag === "h6") {
    const text = renderInlineChildren(element, context).trim();
    return text ? `${"#".repeat(Number(tag[1]))} ${text}` : "";
  }
  if (tag === "p") return renderInlineChildren(element, context).trim();
  if (tag === "div") return renderChildren(Array.from(element.childNodes), context);
  if (tag === "blockquote") {
    const content = renderChildren(Array.from(element.childNodes), context).trim();
    return content ? content.split("\n").map((line) => line ? `> ${line}` : ">").join("\n") : "";
  }
  if (tag === "hr") return "---";
  if (tag === "ul" || tag === "ol") return renderList(element, 0, context);
  if (tag === "table") return renderTable(element);
  if (tag === "input") return "";
  if (blockTags.has(tag)) return renderChildren(Array.from(element.childNodes), context);

  const style = tag === "span" ? spanStyles(element) : { bold: false, italic: false, strike: false };
  const bold = tag === "strong" || (tag === "b" && isBoldB(element)) || style.bold;
  const italic = tag === "em" || tag === "i" || style.italic;
  const strike = ["s", "del", "strike"].includes(tag) || style.strike;
  const childContext: RenderContext = {
    ...context,
    bold: context.bold || bold,
    italic: context.italic || italic,
    strike: context.strike || strike,
  };
  let content = renderInlineChildren(element, childContext);
  if (bold && !context.bold) content = wrap(content, "**");
  if (italic && !context.italic) content = wrap(content, "*");
  if (strike && !context.strike) content = wrap(content, "~~");
  return content;
}

function collapseBlankLinesOutsideCode(markdown: string): string {
  const result: string[] = [];
  let fenceLength = 0;
  let blankPending = false;
  for (const line of markdown.split("\n")) {
    const fence = /^(`{3,})/.exec(line)?.[1];
    if (fenceLength) {
      result.push(line);
      if (fence && fence.length >= fenceLength && /^`+\s*$/.test(line)) fenceLength = 0;
      continue;
    }
    if (fence) fenceLength = fence.length;
    if (!fenceLength && !line.trim()) {
      blankPending = result.length > 0;
      continue;
    }
    if (blankPending) result.push("");
    blankPending = false;
    result.push(line);
  }
  return result.join("\n");
}

/** Convert inert clipboard HTML to Markdown, or return null when it adds no formatting. */
export function htmlToMarkdown(html: string): string | null {
  const document = new DOMParser().parseFromString(neutralizeResources(html), "text/html");
  const body = document.body;
  if (!hasFormatting(body)) return null;
  const markdown = collapseBlankLinesOutsideCode(renderChildren(Array.from(body.childNodes), emptyContext)).trim();
  const plain = normalizeSpace(visibleText(body)).trim();
  return markdown && markdown !== plain ? markdown : null;
}

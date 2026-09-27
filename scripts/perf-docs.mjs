// Shared deterministic fixtures for the browser and native-app performance harnesses.
const LANGUAGES = ["javascript", "python", "rust", "bash", "sql"];
const ADJECTIVES = ["careful", "seasonal", "measured", "quiet", "layered", "durable", "practical", "compact"];
const SUBJECTS = ["field report", "release note", "review pass", "migration plan", "reading list", "design record"];
const VERBS = ["connects", "records", "compares", "summarizes", "checks", "preserves", "explains", "tracks"];
const TOPICS = ["the archive", "the catalog", "the draft", "the preview", "the index", "the snapshot", "the timeline"];
const TABLES = 4;

function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

function pick(rng, values) {
  return values[Math.floor(rng() * values.length)];
}

function section(index, rng) {
  const id = String(index + 1).padStart(4, "0");
  const adjective = pick(rng, ADJECTIVES);
  const subject = pick(rng, SUBJECTS);
  const verb = pick(rng, VERBS);
  const topic = pick(rng, TOPICS);
  const paragraph = `The ${adjective} ${subject} ${verb} ${topic} across a representative set of notes. It keeps **important context** beside *editorial detail*, a \`stable-key-${id}\`, and [the related reference](https://example.com/notes/${id}). The result should remain readable when sections are revised in place.`;
  const listItem = `Review the ${topic} and preserve the source order for case ${id}.`;
  const list = [
    `- ${listItem}`,
    `  - Compare the ${adjective} summary with the linked reference.`,
    `  - [x] Confirm the current record is complete.`,
    `- [ ] Leave a follow-up note for the next review.`,
    `1. Check the previous entry for case ${id}.`,
    `   1. Keep the original wording where it carries meaning.`,
    `2. Record the outcome in the running notes.`,
  ].join("\n");

  const language = LANGUAGES[index % LANGUAGES.length];
  const codeByLanguage = {
    javascript: [
      `const sample${index} = { id: "${id}", ready: true };`,
      `if (sample${index}.ready) console.log(sample${index}.id);`,
      `// Keep this example deterministic for review.`,
    ],
    python: [
      `def read_record_${index}(path):`,
      `    return {"id": "${id}", "path": path}`,
      `print(read_record_${index}("notes.md"))`,
    ],
    rust: [
      `let record_${index} = ("${id}", true);`,
      `if record_${index}.1 { println!("{}", record_${index}.0); }`,
      `// Keep parsing examples short and repeatable.`,
    ],
    bash: [
      `record_id="${id}"`,
      `printf 'record: %s\\n' "$record_id"`,
      `test -n "$record_id"`,
    ],
    sql: [
      `SELECT note_id, status`,
      `FROM review_notes`,
      `WHERE note_id = '${id}' AND status = 'ready';`,
    ],
  };
  const codeLines = codeByLanguage[language];
  const code = [`\`\`\`${language}`, ...codeLines, "\`\`\`"].join("\n");
  const quote = [
    `> A useful note keeps the ${adjective} observation near its evidence.`,
    `> It leaves room for a later reader to check the decision.`,
  ].join("\n");
  const image = index % 100 === 0 ? `\n\n![Local diagram ${id}](assets/diagram-${id}.png)` : "";
  const text = `## ${subject[0].toUpperCase()}${subject.slice(1)} ${id}\n\n${paragraph}${image}\n\n${list}\n\n${quote}\n\n${code}`;

  return {
    text,
    paragraph: text.indexOf(paragraph) + 24,
    list: text.indexOf(listItem) + 12,
    code: text.indexOf(codeLines[0]) + Math.min(5, codeLines[0].length),
  };
}

function table(index, rng) {
  const rows = 24 + Math.floor(rng() * 13); // 24–36 body rows, inside the editor's table-widget budget.
  const lines = [
    `### Reference table ${index + 1}`,
    "",
    "| Record | Area | Observation | Status |",
    "|---|---|---|---|",
  ];
  const body = ["draft", "review", "archive", "preview", "index", "export"];
  const states = ["ready", "checked", "queued", "complete"];
  for (let row = 0; row < rows; row++) {
    const record = String(index * 100 + row + 1).padStart(4, "0");
    lines.push(`| ${record} | ${pick(rng, body)} | ${pick(rng, ADJECTIVES)} note for ${pick(rng, TOPICS)} | ${pick(rng, states)} |`);
  }
  return { text: lines.join("\n"), rows };
}

function generateDocument(targetBytes, seed) {
  const rng = random(seed);
  const blocks = ["# Performance sample\n\nA deterministic mixed Markdown document for editor measurements."];
  const paragraphs = [];
  const lists = [];
  const code = [];
  const tables = [];
  const thresholds = Array.from({ length: TABLES }, (_, i) => Math.floor(targetBytes * (i + 1) / (TABLES + 1)));
  let nextTable = 0;
  let sectionIndex = 0;
  let length = blocks[0].length;

  while (length < targetBytes) {
    if (nextTable < thresholds.length && length >= thresholds[nextTable]) {
      const block = table(nextTable, rng);
      tables.push({ rows: block.rows, from: length + 2 + block.text.indexOf("| Record") });
      blocks.push(block.text);
      length += block.text.length + 2;
      nextTable++;
      continue;
    }

    const block = section(sectionIndex++, rng);
    paragraphs.push(length + 2 + block.paragraph);
    lists.push(length + 2 + block.list);
    code.push(length + 2 + block.code);
    blocks.push(block.text);
    length += block.text.length + 2;
  }

  const text = `${blocks.join("\n\n")}\n`;
  const nearest = (positions, target) => positions.reduce((best, at) =>
    Math.abs(at - target) < Math.abs(best - target) ? at : best, positions[0]);
  const anchors = {
    top: nearest(paragraphs, Math.min(2_000, text.length / 20)),
    middle: nearest(paragraphs, text.length / 2),
    end: nearest(paragraphs, text.length - 2_000),
    list: lists[Math.floor(lists.length / 2)],
    code: code[Math.floor(code.length / 2)],
    table: tables[0].from,
    tableCount: tables.length,
    tableRows: tables.map(({ rows }) => rows),
  };
  return { text, bytes: Buffer.byteLength(text, "utf8"), anchors };
}

export function generatePerfDocuments() {
  return {
    "100kb": generateDocument(100 * 1024, 0x0f3a91),
    "1mb": generateDocument(1024 * 1024, 0x91b5d7),
  };
}

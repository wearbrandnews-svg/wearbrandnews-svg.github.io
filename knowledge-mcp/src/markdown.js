// Lightweight structural checks only; this does not decide whether personal facts are true.
const ID = /\b(?:DEV|APP|SUB|SH|SKIN|SUPP|FOOD|GEAR)-\d{3,}\b/g;
const DEFINITION = /^\|\s*((?:DEV|APP|SUB|SH|SKIN|SUPP|FOOD|GEAR)-\d{3,})\s*\|/;

export function markdownLines(text) {
  let fence = null;
  return text.split('\n').map((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    const fenced = Boolean(fence || marker);
    if (marker && !fence) fence = marker;
    else if (marker && marker[0] === fence?.[0] && marker.length >= fence.length) fence = null;
    return { line, number: index + 1, fenced };
  });
}

function cells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
}

export function inspectMarkdown(text, name = '') {
  const issues = [];
  const definitions = new Map();
  let width = 0;
  let previous = null;
  for (const row of markdownLines(text)) {
    if (row.fenced || !row.line.trim().startsWith('|')) { width = 0; previous = null; continue; }
    const parts = cells(row.line);
    if (parts.every(s => /^:?-{3,}:?$/.test(s))) {
      if (!previous || cells(previous.line).length !== parts.length) issues.push({ code: 'table_header', line: row.number, message: '表の見出しと区切りの列数が一致しません' });
      width = parts.length;
    } else if (width && parts.length !== width) {
      issues.push({ code: 'table_columns', line: row.number, message: `表は${width}列ですが、この行は${parts.length}列です` });
    }
    const id = DEFINITION.exec(row.line)?.[1];
    if (id) {
      if (!width) issues.push({ code: 'orphan_product_row', id, line: row.number, message: '商品行が表の見出し・区切りから分離しています' });
      if (definitions.has(id)) issues.push({ code: 'duplicate_id', id, line: row.number, message: '商品IDが重複しています' });
      definitions.set(id, row.number);
    }
    previous = row;
  }
  return { name, issues, definitions: [...definitions.keys()] };
}

export function inspectKnowledge(files) {
  const issues = [];
  const defined = new Set();
  const definitions = new Map();
  for (const file of files) {
    const checked = inspectMarkdown(file.content, file.name);
    issues.push(...checked.issues.map(issue => ({ file: file.name, ...issue })));
    for (const id of checked.definitions) {
      if (definitions.has(id)) issues.push({ file: file.name, code: 'duplicate_id', id, message: `${definitions.get(id)}と商品IDが重複しています` });
      definitions.set(id, file.name); defined.add(id);
    }
  }
  for (const file of files) {
    const missing = new Set();
    for (const row of markdownLines(file.content)) {
      if (row.fenced) continue;
      for (const id of row.line.match(ID) || []) if (!defined.has(id)) missing.add(id);
    }
    for (const id of missing) issues.push({ file: file.name, code: 'missing_id', id, message: '参照先の商品IDが商品一覧にありません' });
  }
  return { issues, files_checked: files.length, product_count: defined.size };
}

export function selectMarkdown(content, input) {
  if (input.section !== undefined && input.product_ids !== undefined) return { error: 'sectionとproduct_idsは同時に指定できません' };
  const lines = markdownLines(content);
  if (input.section !== undefined) {
    if (typeof input.section !== 'string' || !input.section.trim()) return { error: 'sectionは空でない見出し名です' };
    const matches = lines.filter(row => !row.fenced && /^#{1,6}\s+/.test(row.line) && row.line.replace(/^#{1,6}\s+/, '').replace(/\s+#+\s*$/, '').trim() === input.section);
    if (matches.length !== 1) return { error: `見出しの一致が${matches.length}件です（ちょうど1件が必要）` };
    const start = matches[0].number - 1;
    const depth = /^#+/.exec(lines[start].line)[0].length;
    let end = start + 1;
    while (end < lines.length && (lines[end].fenced || !/^#{1,6}\s+/.test(lines[end].line) || /^#+/.exec(lines[end].line)[0].length > depth)) end++;
    return { content: lines.slice(start, end).map(r => r.line).join('\n'), complete: false };
  }
  if (input.product_ids !== undefined) {
    if (!Array.isArray(input.product_ids) || !input.product_ids.length || input.product_ids.length > 50 || input.product_ids.some(id => typeof id !== 'string' || !/^(DEV|APP|SUB|SH|SKIN|SUPP|FOOD|GEAR)-\d{3,}$/.test(id))) return { error: 'product_idsは有効な商品IDの配列（1〜50件）です' };
    const wanted = new Set(input.product_ids), found = new Set();
    const output = [];
    let heading = '', header = '', separator = '', previous = '', lastTable = -1, table = 0;
    for (const row of lines) {
      if (row.fenced) { previous = ''; continue; }
      if (/^#{1,6}\s+/.test(row.line)) heading = row.line;
      if (!row.line.trim().startsWith('|')) { header = ''; separator = ''; previous = ''; continue; }
      if (cells(row.line).every(s => /^:?-{3,}:?$/.test(s))) { header = previous; separator = row.line; table++; }
      const id = DEFINITION.exec(row.line)?.[1];
      if (id && wanted.has(id)) {
        if (found.has(id)) return { error: `${id}の定義が重複しています` };
        if (!header || !separator) return { error: `${id}の表の見出しが見つかりません` };
        if (lastTable !== table) { output.push(heading, header, separator); lastTable = table; }
        output.push(row.line); found.add(id);
      }
      previous = row.line;
    }
    const missing = [...wanted].filter(id => !found.has(id));
    if (missing.length) return { error: `商品IDがありません：${missing.join(', ')}` };
    return { content: output.join('\n'), complete: false };
  }
  return { content, complete: true };
}

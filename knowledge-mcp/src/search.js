import { markdownLines } from './markdown.js';

// Local lexical search: no embeddings, external model calls, stored index or timers.
const GROUPS = [
  ['サプリ', '飲んでいる', '飲んでる', '飲む', '服用', '摂取', '薬'],
  ['プロテイン', 'たんぱく質', 'タンパク質', 'wpi', '粉末'],
  ['ランニング', 'シューズ', '靴', 'ボメロ', 'マラソン'],
  ['昼食', '昼ご飯', '昼ごはん', 'ランチ'],
  ['夕食', '夕ご飯', '夕ごはん', '晩ご飯'],
  ['スマートホーム', '家電', '照明', '電球', 'リモコン', 'switchbot', 'homepod'],
  ['契約', 'サブスク', '月額', '課金'],
  ['カレンダー', '予定管理', 'リマインダー', 'タスク', 'メモアプリ'],
  ['保存', 'バックアップ', '復元', '競合', '同期', 'workers', 'mcp', 'obsidian'],
];
const normalize = value => value.normalize('NFKC').toLowerCase();
const unique = values => [...new Set(values)];

export function searchTerms(query) {
  const q = normalize(query);
  const words = q.match(/[a-z][a-z0-9_-]*|\d{1,2}:\d{2}|[\p{Script=Han}\p{Script=Katakana}ー]{2,}/gu) || [];
  const aliases = GROUPS.filter(group => group.some(word => q.includes(word))).flat();
  const hours = [...q.matchAll(/(\d{1,2})時/g)].map(m => `${m[1].padStart(2, '0')}:00`);
  const grams = [];
  for (const word of words.filter(word => /^[\p{Script=Han}\p{Script=Katakana}ー]+$/u.test(word))) {
    if (word.length > 3) for (let i = 0; i < word.length - 1; i++) grams.push(word.slice(i, i + 2));
  }
  return { q, direct: unique([...words, ...hours]), aliases: unique(aliases), grams: unique(grams).slice(0, 60) };
}

function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map(s => s.trim());
}

function blocks(content) {
  const rows = markdownLines(content), output = [];
  const headings = [];
  let preamble = [], tableHeader = '', tableSeparator = '';
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.fenced) continue;
    const heading = /^(#{1,6})\s+(.+)$/.exec(row.line);
    if (heading) {
      headings.length = heading[1].length - 1;
      headings.push(heading[2]);
      preamble = []; tableHeader = ''; tableSeparator = '';
      continue;
    }
    const text = row.line.trim();
    if (!text) { tableHeader = ''; tableSeparator = ''; continue; }
    if (text.startsWith('|')) {
      const cells = tableCells(text);
      if (cells.every(c => /^:?-{3,}:?$/.test(c))) {
        tableHeader = rows[i - 1]?.line || ''; tableSeparator = row.line; continue;
      }
      if (!tableSeparator) continue;
      output.push({ section: headings.filter(Boolean).join(' > '), line_start: row.number, line_end: row.number,
        text: `${tableHeader}\n${tableSeparator}\n${row.line}`, body: row.line, source_notes: preamble.join('\n').slice(0, 900) });
    } else {
      tableHeader = ''; tableSeparator = '';
      output.push({ section: headings.filter(Boolean).join(' > '), line_start: row.number, line_end: row.number, text: row.line, body: row.line, source_notes: '' });
      if (!/^[-*]\s/.test(text) && preamble.length < 3) preamble.push(text);
    }
  }
  return output;
}

export function searchMarkdown(content, name, query, limit = 5) {
  const terms = searchTerms(query);
  const wantsPast = /以前|過去|履歴|経緯|変更前|昔/.test(query);
  const wantsCurrent = /今|現在|予定|使って|飲んで/.test(query);
  return blocks(content).map(block => {
    const body = normalize(block.body), section = normalize(block.section);
    let score = 0, bodyHits = 0;
    for (const word of terms.direct) {
      if (body.includes(word)) { score += word.length >= 3 ? 6 : 3; bodyHits++; }
      else if (section.includes(word)) score += 1;
    }
    for (const word of terms.aliases) {
      if (body.includes(word)) { score += 1.2; bodyHits++; }
      else if (section.includes(word)) score += 0.2;
    }
    for (const word of terms.grams) if (body.includes(word)) { score += 0.5; bodyHits++; }
    if (terms.aliases.includes('サプリ') && /supp-\d{3,}/.test(body)) { score += 2; bodyHits++; }
    for (const id of terms.direct.filter(word => /^(dev|app|sub|sh|skin|supp|food|gear)-\d{3,}$/.test(word))) {
      if (body.startsWith(`| ${id} |`)) { score += 25; bodyHits++; }
    }
    if (!bodyHits) score = 0;
    const history = /更新履歴|アーカイブ/.test(block.section);
    if (history && !wantsPast) score *= 0.12;
    if (/反映されない|できない|動かない|エラー|失敗|タイムアウト|古い/.test(query) && /障害対応|トラブル/.test(block.section)) score *= 2;
    if (wantsCurrent && /^\|/.test(block.body)) {
      const state = tableCells(block.body)[2] || '';
      if (/購入予定|使用中|契約中/.test(state)) score += score ? 3 : 0;
      if (/検討終了|使用終了/.test(state)) score *= 0.5;
    }
    const { body: ignored, ...result } = block;
    return { ...result, score: Math.round(score * 100) / 100, file: name, history };
  }).filter(block => block.score > 0).sort((a, b) => b.score - a.score || a.line_start - b.line_start).slice(0, limit);
}

export function routeFiles(files, query) {
  const q = normalize(query), wanted = new Set();
  if (/サプリ|飲ん|服用|摂取|薬|プロテイン|たんぱく|粉末|成分|栄養|ビタミン|マグネシウム|亜鉛|グリシン|クレアチン|カフェイン|食事|昼食|夕食|健診|検査|肌|スキンケア|ランニング|シューズ|靴|マラソン/.test(q)) {
    wanted.add('products.md'); wanted.add('health-training.md');
  }
  if (/スマートホーム|家電|照明|電球|リモコン|switchbot|homepod/.test(q)) { wanted.add('products.md'); wanted.add('smart-home.md'); }
  if (/契約|サブスク|月額|課金|カレンダー|予定管理|リマインダー|メモアプリ|タスク/.test(q)) { wanted.add('products.md'); wanted.add('life-decisions.md'); }
  if (/仕事|身長|体重|住ん|居住|起床|就寝|生活リズム|無料|好み|判断基準/.test(q)) wanted.add('knowledge.md');
  if (/保存|バックアップ|復元|競合|同期|workers|mcp|obsidian|db|ルール/.test(q)) { wanted.add('AI-Rules.md'); wanted.add('system-maintenance.md'); }
  if (/(DEV|APP|SUB|SH|SKIN|SUPP|FOOD|GEAR)-\d{3,}/i.test(query)) wanted.add('products.md');
  return files.filter(file => wanted.has(file.name));
}

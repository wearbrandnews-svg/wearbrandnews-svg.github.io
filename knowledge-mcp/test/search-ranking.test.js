import assert from 'node:assert/strict';
import { test } from 'node:test';
import { routeFiles, searchMarkdown } from '../src/search.js';

// Synthetic records only. Product names in the routing checks are public vocabulary,
// not records of a person's purchases, medication or usage.
test('routes public product and drug vocabulary without reading unrelated domains', () => {
  const files = ['products.md', 'health-training.md', 'smart-home.md', 'life-decisions.md', 'knowledge.md', 'system-maintenance.md'].map(name => ({ name }));
  for (const query of ['ボメロ18', 'ズーム フライ6', 'トラネキサム酸', 'マキュガード', 'MacuGuard', 'Zoom Fly']) {
    assert.deepEqual(routeFiles(files, query).map(f => f.name), ['products.md', 'health-training.md']);
  }
  assert.deepEqual(routeFiles(files, 'おはようございます'), []);
});

test('specific ingredient evidence outranks generic supplement timing', () => {
  const products = '# 商品\n| ID | 名前 | 状態 |\n|---|---|---|\n| SUPP-901 | 試験用亜鉛 | 使用中 |\n| SUPP-902 | 試験用プロテイン | 使用中 |\n';
  const usage = '# 使い方\n- プロテイン等の摂取タイミング：試験用粉末。\n| 時刻 | 内容 |\n|---|---|\n| 夜 | 亜鉛（SUPP-901） |\n';
  const query = '亜鉛の製品と摂取タイミング';
  const results = [...searchMarkdown(products, 'products.md', query), ...searchMarkdown(usage, 'health-training.md', query)].sort((a,b)=>b.score-a.score).slice(0, 2);
  assert.equal(results.length, 2);
  assert.ok(results.every(r => r.text.includes('亜鉛')));
  assert.ok(results.some(r => r.file === 'products.md'));
  assert.ok(results.some(r => r.file === 'health-training.md'));
});

test('keeps a model number attached when asking about an ended candidate', () => {
  const text = '# 商品\n| ID | 名前 | 状態 | 備考 |\n|---|---|---|---|\n| GEAR-901 | フィクション18 | 検討終了 | 次の候補へ変更 |\n| GEAR-902 | フィクション20 | 購入予定 | 現在の候補 |\n';
  const results = searchMarkdown(text, 'products.md', 'フィクション18は今も検討中？');
  assert.ok(results[0].text.includes('GEAR-901'));
  assert.ok(results[0].text.includes('検討終了'));
});

test('model matching tolerates spacing and full width numbers', () => {
  const text = '# 商品\n| ID | 名前 | 状態 |\n|---|---|---|\n| GEAR-901 | サンプル フライ ６ | 検討終了 |\n| GEAR-902 | サンプル フライ ８ | 購入予定 |\n';
  assert.ok(searchMarkdown(text, 'products.md', 'サンプルフライ6は今の予定？')[0].text.includes('GEAR-901'));
});

test('current system questions prioritize current state over rollback instructions', () => {
  const text = '# 保守\n## 切り戻し手順\n- ArchiveEngineの保存を復元する。ArchiveEngineへ戻す保存の手順。\n## 現在の状態\n- ArchiveEngineは停止し、次の方式を使用中。\n';
  assert.ok(searchMarkdown(text, 'system-maintenance.md', 'ArchiveEngineは今も保存に使っている？')[0].section.includes('現在の状態'));
});

test('explicit rollback questions can still retrieve rollback instructions', () => {
  const text = '# 保守\n## 切り戻し手順\n- ArchiveEngineへ戻す手順。\n## 現在の状態\n- ArchiveEngineは停止中。\n';
  assert.ok(searchMarkdown(text, 'system-maintenance.md', 'ArchiveEngineへ戻す手順は？')[0].section.includes('切り戻し'));
});

test('effect questions retrieve uncertain self assessment rather than dosage alone', () => {
  const text = '# 健康\n## 使用\n| 時刻 | 内容 |\n|---|---|\n| 夜 | 試験用サプリ（SUPP-901）を摂取 |\n- 効果・不調：本人の不確かな自己評価。製品別の効果は未確認。\n';
  const results = searchMarkdown(text, 'health-training.md', '今飲んでいる製品のうち効いているのはどれ？');
  assert.ok(results[0].text.includes('不確かな自己評価'));
  assert.ok(results[0].text.includes('未確認'));
});

test('current intent does not promote archived subject matches', () => {
  const text = '# 状態\n## 更新履歴\n- 試験用亜鉛を以前検討していた。\n## 現在\n- 試験用亜鉛は使用中。\n';
  assert.equal(searchMarkdown(text, 'health-training.md', '今の亜鉛は？')[0].history, false);
});

test('purchase quantities for two products rank above joint placement mentions', () => {
  const products = '# 商品\n| ID | 名前 | 状態 | 数量 |\n|---|---|---|---|\n| SH-901 | 試験用電球 | 購入予定 | 8個 |\n| SH-902 | 試験用リモコン | 購入予定 | 2個 |\n';
  const plan = '# 配置案\n- 電球とリモコンを部屋Aへ。\n- 電球とリモコンを部屋Bへ。\n- 電球とリモコンを部屋Cへ。\n';
  const query = '購入予定の電球とリモコンの数は？';
  const results = [...searchMarkdown(products, 'products.md', query), ...searchMarkdown(plan, 'smart-home.md', query)].sort((a,b)=>b.score-a.score).slice(0,2);
  assert.ok(results.some(r=>r.text.includes('SH-901')));
  assert.ok(results.some(r=>r.text.includes('SH-902')));
});

test('effect intent still discounts historical self assessment', () => {
  const text = '# 健康\n## 更新履歴\n- 効果・不調：本人はサプリの変化を実感したという過去の自己評価。\n## 現在\n- 効果：本人の自己評価は不確か。\n';
  assert.equal(searchMarkdown(text, 'health-training.md', '今飲んでいるサプリは効いている？')[0].history, false);
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseGitignore } from '../agent/gitignore';

const ignored = (patterns: RegExp[], rel: string) => patterns.some((re) => re.test(rel));

test('настоящий .gitignore этого репозитория: каждая его строка скрывает соответствующий путь', () => {
  // Читаем файл на ходу — тест не зависит от того, какие папки в нём перечислены
  const text = readFileSync(join(__dirname, '..', '..', '.gitignore'), 'utf8');
  const patterns = parseGitignore(text);
  const entries = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !l.startsWith('!'));
  assert.ok(entries.length > 0);
  for (const entry of entries) {
    // Путь, который должен попасть под строку: «*» заменяем на имя, «/» по краям убираем
    const rel = entry.replace(/^\/+|\/+$/g, '').replace(/\*+/g, 'x');
    assert.ok(ignored(patterns, rel), `${entry} → ${rel}`);
    assert.ok(ignored(patterns, `${rel}/inner/file`), `${entry} → вложенные пути`);
  }
});

test('синтаксис .gitignore на абстрактных именах', () => {
  const p = parseGitignore('# комментарий\ndir-a/\n*.tmp\n/top/only\n!keep.tmp\nname-b\n');
  for (const rel of ['dir-a', 'x/dir-a/file', 'deep/file.tmp', 'top/only/file', 'name-b', 'x/y/name-b'])
    assert.ok(ignored(p, rel), rel);
  for (const rel of ['dir-ab', 'file.tmpl', 'x/top/only', 'name-bc', 'keep'])
    assert.ok(!ignored(p, rel), rel);
});


test('маска поиска', async () => {
  const { globToRegExp } = await import('../agent/gitignore');
  const cases: [string, string[], string[]][] = [
    ['**/*.bsl', ['a.bsl', 'x/y/a.bsl'], ['a.bslx', 'a.txt']],
    ['*.md', ['README.md', 'docs/a.md'], ['a.mdx']],
    ['src/**', ['src/a', 'src/x/y'], ['lib/src/a']],
    ['src/**/*.ts', ['src/a.ts', 'src/x/a.ts'], ['lib/a.ts', 'src/a.tsx']],
  ];
  for (const [glob, yes, no] of cases) {
    const re = globToRegExp(glob);
    for (const p of yes) assert.ok(re.test(p), `${glob} ~ ${p}`);
    for (const p of no) assert.ok(!re.test(p), `${glob} !~ ${p}`);
  }
});

test('«**/имя» в .gitignore скрывает и папку в корне', () => {
  const [re] = parseGitignore('**/node_modules');
  assert.ok(re.test('node_modules'));
  assert.ok(re.test('pkg/node_modules/x.js'));
  assert.ok(!re.test('src/node_modules_old'));
});

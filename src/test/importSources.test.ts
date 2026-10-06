import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  MAX_IMPORT_FILE_CHARS,
  MAX_IMPORT_TOTAL_CHARS,
  buildImportPrompt,
  classifyProjectFile,
  describeFile,
  makeFoundFile,
  parseImportArgs,
  readUserFiles,
  scanReport,
  selectForImport,
} from '../agent/importSources';

test('parseImportArgs: источники, синонимы, all, неизвестные', () => {
  assert.deepEqual(parseImportArgs(''), { sources: [], unknown: [] });
  assert.deepEqual(parseImportArgs('Cursor  claude, cursor'), { sources: ['cursor', 'claude'], unknown: [] });
  assert.deepEqual(parseImportArgs('agents github'), { sources: ['codex', 'copilot'], unknown: [] });
  assert.equal(parseImportArgs('all').sources.length, 6);
  assert.deepEqual(parseImportArgs('cursor vim').unknown, ['vim']);
});

test('classifyProjectFile: правила, настройки и посторонние файлы', () => {
  assert.deepEqual(classifyProjectFile('CLAUDE.md'), { source: 'claude', settings: false });
  assert.deepEqual(classifyProjectFile('sub/project/CLAUDE.md'), { source: 'claude', settings: false });
  assert.deepEqual(classifyProjectFile('.claude/settings.json'), { source: 'claude', settings: true });
  assert.deepEqual(classifyProjectFile('.claude/commands/review.md'), { source: 'claude', settings: false });
  assert.deepEqual(classifyProjectFile('AGENTS.md'), { source: 'codex', settings: false });
  assert.deepEqual(classifyProjectFile('.cursor/rules/bsl.mdc'), { source: 'cursor', settings: false });
  assert.deepEqual(classifyProjectFile('.cursor/mcp.json'), { source: 'cursor', settings: true });
  assert.deepEqual(classifyProjectFile('.github/copilot-instructions.md'), { source: 'copilot', settings: false });
  assert.deepEqual(classifyProjectFile('.windsurfrules'), { source: 'windsurf', settings: false });
  assert.equal(classifyProjectFile('README.md'), undefined);
  assert.equal(classifyProjectFile('docs/CLAUDE.md.bak'), undefined);
  assert.equal(classifyProjectFile('.rules/git.md'), undefined);
  // Копии репозитория из worktree Claude Code и прочие .md в .claude — не правила
  assert.equal(classifyProjectFile('.claude/worktrees/fix/CLAUDE.md'), undefined);
  assert.equal(classifyProjectFile('.claude/worktrees/fix/README.md'), undefined);
  assert.equal(classifyProjectFile('.claude/notes.md'), undefined);
});

test('describeFile: description из .mdc, заголовок, обрезка', () => {
  assert.equal(describeFile('---\ndescription: "Правила BSL"\nglobs: *.bsl\n---\n# Другое'), 'Правила BSL');
  assert.equal(describeFile('\n\n# CLAUDE.md\n\nтекст'), 'CLAUDE.md');
  assert.equal(describeFile(''), '(пусто)');
  assert.equal(describeFile('x'.repeat(200)).length, 80);
});

test('selectForImport: новые, изменившиеся, уже перенесённые, большие и настройки', () => {
  const fresh = makeFoundFile('claude', 'CLAUDE.md', 'новое', false);
  const same = makeFoundFile('cursor', '.cursorrules', 'старое', false);
  const edited = makeFoundFile('codex', 'AGENTS.md', 'правка', false);
  const big = makeFoundFile('gemini', 'GEMINI.md', 'x'.repeat(MAX_IMPORT_FILE_CHARS + 1), false);
  const settings = makeFoundFile('claude', '.claude/settings.json', '{}', false, true);
  const state = { '.cursorrules': same.hash, 'AGENTS.md': 'прежний-хеш' };

  const sel = selectForImport([fresh, same, edited, big, settings], state);
  assert.deepEqual(
    sel.files.map((f) => [f.path, f.status]),
    [
      ['CLAUDE.md', 'new'],
      ['AGENTS.md', 'changed'],
    ],
  );
  assert.deepEqual(sel.unchanged.map((f) => f.path), ['.cursorrules']);
  assert.deepEqual(sel.tooLarge.map((f) => f.path), ['GEMINI.md']);
  assert.deepEqual(sel.settings.map((f) => f.path), ['.claude/settings.json']);

  const prompt = buildImportPrompt(sel);
  assert.ok(prompt.includes('--- CLAUDE.md (Claude Code) ---\nновое'));
  assert.ok(prompt.includes('изменился после прошлого переноса'));
  assert.ok(prompt.includes('.claude/settings.json — настройки инструмента'));
  assert.ok(prompt.includes('.cursorrules — уже перенесён'));
  assert.ok(!prompt.includes('x'.repeat(100)));
});

test('selectForImport: не поместившееся в сообщение откладывается, а не считается большим', () => {
  const chunk = 'x'.repeat(MAX_IMPORT_FILE_CHARS);
  const count = Math.floor(MAX_IMPORT_TOTAL_CHARS / MAX_IMPORT_FILE_CHARS) + 1;
  const found = Array.from({ length: count }, (_, i) => makeFoundFile('claude', `p${i}/CLAUDE.md`, chunk + i, false));
  const sel = selectForImport(found, {});
  assert.equal(sel.tooLarge.length, count);
  const fits = found.map((f) => makeFoundFile('claude', f.path, 'x'.repeat(MAX_IMPORT_FILE_CHARS - 10), false));
  const sel2 = selectForImport(fits, {});
  assert.equal(sel2.tooLarge.length, 0);
  assert.equal(sel2.deferred.length, count - sel2.files.length);
  assert.ok(sel2.deferred.length > 0);
  assert.ok(buildImportPrompt(sel2).includes('будет передан при следующем /import'));
});

test('scanReport: группировка по инструментам и подсказка команды', () => {
  const report = scanReport(
    [makeFoundFile('cursor', '.cursorrules', '# Стиль\n- табы', false), makeFoundFile('claude', '~/.claude/CLAUDE.md', 'общее', true)],
    {},
  );
  assert.ok(report.includes('**Claude Code** — `/import claude`'));
  assert.ok(report.includes('`.cursorrules` — Стиль · 2 стр. · новый'));
  assert.ok(report.includes('пользовательский'));
  assert.ok(report.includes('`/import claude cursor`'));
  assert.ok(scanReport([], {}).includes('не найдено'));
});

test('readUserFiles: только существующие непустые файлы, без папок целиком', async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), 'naparnik-home-'));
  await mkdir(path.join(home, '.claude', 'projects'), { recursive: true });
  await writeFile(path.join(home, '.claude', 'CLAUDE.md'), '﻿общие правила');
  await writeFile(path.join(home, '.claude', 'projects', 'chat.md'), 'история чата');
  await mkdir(path.join(home, '.gemini'));
  await writeFile(path.join(home, '.gemini', 'GEMINI.md'), '  \n');

  const files = await readUserFiles(home);
  assert.deepEqual(
    files.map((f) => [f.source, f.path, f.text, f.user]),
    [['claude', '~/.claude/CLAUDE.md', 'общие правила', true]],
  );
});

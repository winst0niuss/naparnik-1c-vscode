import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { FolderReadTools, isInsideFolders } from '../agent/folderReadTools';
import type { AgentCommand } from '../agent/protocol';
import { overflowReadHint } from '../agent/mentions';

function tools(folders: string[]) {
  const calls: AgentCommand[] = [];
  const t = new FolderReadTools({ run: async (cmd) => (calls.push(cmd), 'ok') }, folders);
  return { t, calls };
}

test('isInsideFolders: только внутри папок, без «..»', () => {
  const f = ['src/cf/', 'docs/'];
  assert.ok(isInsideFolders('src/cf/a.bsl', f));
  assert.ok(isInsideFolders('./src/cf/x/y.bsl', f));
  assert.ok(isInsideFolders('src/cf', f));
  assert.ok(!isInsideFolders('src/cfx/a.bsl', f));
  assert.ok(!isInsideFolders('src/cf/../../secret', f));
  assert.ok(!isInsideFolders('package.json', f));
});

test('FolderReadTools: чтение внутри папок выполняется, снаружи и изменения — отказ', async () => {
  const { t, calls } = tools(['src/cf/']);
  assert.equal(await t.run({ kind: 'read_file', path: 'src/cf/a.bsl' }), 'ok');
  assert.equal(await t.run({ kind: 'list_dir', path: 'src/cf' }), 'ok');
  assert.match(await t.run({ kind: 'read_file', path: 'package.json' }), /не внутри приложенных папок/);
  assert.match(await t.run({ kind: 'create_file', path: 'src/cf/b.bsl', content: '' }), /недоступна/);
  assert.match(await t.run({ kind: 'delete_file', path: 'src/cf/a.bsl' }), /недоступна/);
  assert.equal(calls.length, 2);
});

test('FolderReadTools: поиск — только в папках, маска внутри папки — как есть', async () => {
  const { t, calls } = tools(['a/', 'b/']);
  await t.run({ kind: 'search', query: 'X' });
  await t.run({ kind: 'search', query: 'X', glob: '*.bsl' });
  await t.run({ kind: 'search', query: 'X', glob: 'a/sub/*.bsl' });
  await t.run({ kind: 'search', query: 'X', glob: 'other/*.bsl' });
  assert.deepEqual(
    calls.map((c) => (c.kind === 'search' ? c.glob : '')),
    ['a/**/*', 'b/**/*', 'a/**/*.bsl', 'b/**/*.bsl', 'a/sub/*.bsl', 'a/**/*.bsl', 'b/**/*.bsl'],
  );
});

test('FolderReadTools: маска — имя папки: внутри приложенной — ищем в ней, иначе — во всех', async () => {
  const { t, calls } = tools(['x/tests/']);
  await t.run({ kind: 'search', query: 'X', glob: 'tests' });
  await t.run({ kind: 'search', query: 'X', glob: 'x/tests/geo' });
  assert.deepEqual(
    calls.map((c) => (c.kind === 'search' ? c.glob : '')),
    ['x/tests/**/*', 'x/tests/geo/**/*'],
  );
});

test('overflowReadHint: без доступа — синтаксис команд и ограничение, с доступом — коротко', () => {
  assert.equal(overflowReadHint([], false), '');
  const off = overflowReadHint(['tests/'], false);
  assert.ok(off.includes('@read_file путь') && off.includes('только внутри этих папок') && off.includes('tests/'));
  const on = overflowReadHint(['tests/'], true);
  assert.ok(on.includes('@read_file') && !on.includes('@list_dir'));
});

import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SLASH_COMMANDS, helpText, parseSlash } from '../slashCommands';

test('parseSlash: команды, аргументы, не-команды', () => {
  assert.deepEqual(parseSlash('/init'), { name: 'init', args: '' });
  assert.deepEqual(parseSlash('  /Make-Rules  '), { name: 'make-rules', args: '' });
  assert.deepEqual(parseSlash('/branch feature/x'), { name: 'branch', args: 'feature/x' });
  assert.equal(parseSlash('как сделать /init?'), undefined);
  assert.equal(parseSlash('/'), undefined);
  assert.equal(parseSlash('src/Documents/a.bsl'), undefined);
});

test('help перечисляет все команды', () => {
  for (const c of SLASH_COMMANDS) assert.ok(helpText().includes('/' + c.name));
});

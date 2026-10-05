import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { EditorSnapshot, SECRET_FILE, contextLabel, formatEditorContext } from '../agent/editorContext';

const base: EditorSnapshot = {
  path: 'src/Documents/Заказ/Ext/ObjectModule.bsl',
  inWorkspace: true,
  languageId: 'bsl',
  lineCount: 40,
  fullText: 'Процедура А()\nКонецПроцедуры',
  diagnostics: [
    { line: 2, severity: 'ошибка', message: 'Ожидается ;' },
    { line: 30, severity: 'предупреждение', message: 'Неиспользуемая переменная' },
  ],
};

test('подпись чипа: файл, строка, диапазон строк', () => {
  assert.equal(contextLabel(base), 'ObjectModule.bsl');
  assert.equal(contextLabel({ ...base, selection: { startLine: 5, endLine: 5, text: 'x' } }), 'ObjectModule.bsl · строка 5');
  assert.equal(contextLabel({ ...base, selection: { startLine: 10, endLine: 24, text: 'x' } }), 'ObjectModule.bsl · строки 10–24');
});

test('без выделения — текст файла и все ошибки', () => {
  const text = formatEditorContext(base);
  assert.ok(text.includes('Файл: src/Documents/Заказ/Ext/ObjectModule.bsl (bsl, 40 стр.)'));
  assert.ok(text.includes('Процедура А()\nКонецПроцедуры'));
  assert.ok(text.includes('строка 2: ошибка: Ожидается ;') && text.includes('строка 30: предупреждение'));
});

test('с выделением — только выделенный код и ошибки внутри него', () => {
  const text = formatEditorContext({ ...base, selection: { startLine: 1, endLine: 5, text: 'Выделенный код' } });
  assert.ok(text.includes('выделил строки 1–5'));
  assert.ok(text.includes('Выделенный код') && !text.includes('КонецПроцедуры'));
  assert.ok(text.includes('строка 2: ошибка') && !text.includes('строка 30'));
});

test('файл вне проекта, обрезка большого файла, ``` внутри кода', () => {
  const big = formatEditorContext({ ...base, inWorkspace: false, fullText: 'а'.repeat(40_000) });
  assert.ok(big.includes('вне открытого проекта') && big.includes('обрезано: показаны первые 30000 символов из 40000'));
  const md = formatEditorContext({ ...base, languageId: 'markdown', fullText: 'пример:\n```bsl\nКод\n```' });
  assert.ok(md.includes('````markdown\n'), 'обрамление длиннее, чем ``` внутри текста');
});

test('секреты не прикладываются', () => {
  for (const p of ['/p/.env', '/p/.env.local', '/p/certs/server.pem', '/home/u/.ssh/id_rsa']) assert.ok(SECRET_FILE.test(p), p);
  for (const p of ['/p/src/Module.bsl', '/p/README.md', '/p/environment.ts']) assert.ok(!SECRET_FILE.test(p), p);
});

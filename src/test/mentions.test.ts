import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { MAX_MENTION_FILE_CHARS, MAX_MENTION_TOTAL_CHARS, findMentions, formatMentionedFiles, rankPaths, resolveMention } from '../agent/mentions';

const PATHS = [
  'README.md',
  'docs/Мой файл.md',
  'src/cf/Catalogs/Клиенты/Ext/ObjectModule.bsl',
  'src/cf/Documents/Заявка/Ext/ObjectModule.bsl',
  'src/cf/CommonModules/ОбщегоНазначения/Ext/Module.bsl',
];

test('findMentions: пути, кавычки, без повторов; email и середина слова — не упоминания', () => {
  assert.deepEqual(findMentions('Посмотри @README.md и @"docs/Мой файл.md", ещё раз @README.md'), ['README.md', 'docs/Мой файл.md']);
  assert.deepEqual(findMentions('пиши на user@mail.ru'), []);
  assert.deepEqual(findMentions('@src/a.bsl'), ['src/a.bsl']);
});

test('resolveMention: точный путь, уникальное имя, хвост пути, неоднозначность, знаки препинания', () => {
  assert.deepEqual(resolveMention('README.md', PATHS), { path: 'README.md' });
  assert.deepEqual(resolveMention('./readme.md', PATHS), { path: 'README.md' });
  assert.deepEqual(resolveMention('Module.bsl', PATHS), { path: 'src/cf/CommonModules/ОбщегоНазначения/Ext/Module.bsl' });
  assert.deepEqual(resolveMention('Заявка/Ext/ObjectModule.bsl', PATHS), { path: 'src/cf/Documents/Заявка/Ext/ObjectModule.bsl' });
  assert.deepEqual(resolveMention('ObjectModule.bsl', PATHS), { candidates: [PATHS[2], PATHS[3]] });
  assert.deepEqual(resolveMention('README.md,', PATHS), { path: 'README.md' });
  assert.equal(resolveMention('нет.bsl', PATHS), undefined);
});

test('rankPaths: имя файла выше вхождения в путь, части через «/», пустой запрос — верхние уровни', () => {
  assert.deepEqual(rankPaths('module', PATHS).slice(0, 1), ['src/cf/CommonModules/ОбщегоНазначения/Ext/Module.bsl']);
  assert.deepEqual(rankPaths('клиенты/object', PATHS), ['src/cf/Catalogs/Клиенты/Ext/ObjectModule.bsl']);
  assert.deepEqual(rankPaths('', PATHS, 2), ['README.md', 'docs/Мой файл.md']);
  assert.deepEqual(rankPaths('zzz', PATHS), []);
});

test('formatMentionedFiles: язык по расширению, обрезка большого файла, лимит на все файлы', () => {
  const { text } = formatMentionedFiles([{ path: 'a.bsl', text: 'Процедура А()\nКонецПроцедуры' }]);
  assert.ok(text.includes('--- a.bsl ---\n```bsl\nПроцедура А()'));
  assert.ok(text.includes('повторно их не читай'));
  const big = 'x'.repeat(MAX_MENTION_FILE_CHARS + 10);
  assert.ok(formatMentionedFiles([{ path: 'b.txt', text: big }]).text.includes(`показаны первые ${MAX_MENTION_FILE_CHARS} символов`));
  const many = Array.from({ length: Math.ceil(MAX_MENTION_TOTAL_CHARS / MAX_MENTION_FILE_CHARS) + 1 }, (_, i) => ({ path: `f${i}.txt`, text: big }));
  const r = formatMentionedFiles(many);
  assert.ok(r.skipped.length > 0);
  assert.ok(r.text.includes('Не приложены из-за объёма'));
  assert.deepEqual(formatMentionedFiles([]), { text: '', skipped: [] });
});

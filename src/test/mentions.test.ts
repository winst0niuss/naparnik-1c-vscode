import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  MAX_MENTION_FILE_CHARS,
  MAX_MENTION_TOTAL_CHARS,
  attachmentLabel,
  findMentions,
  folderFiles,
  formatMentionedFiles,
  formatSelection,
  fragmentKey,
  parseFragment,
  pickFolderFiles,
  rankPaths,
  resolveMention,
  shortNames,
  sliceLines,
  withFolders,
} from '../agent/mentions';

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
  // Перечень приложенных — в начале блока: модель теряла последний файл после длинных
  const two = formatMentionedFiles([{ path: 'a.bsl', text: 'x'.repeat(500) }, { path: 'b.json', text: '{}' }]).text;
  assert.ok(two.startsWith('[Файлы, приложенные пользователем к вопросу (2): a.bsl, b.json.'));
  const big = 'x'.repeat(MAX_MENTION_FILE_CHARS + 10);
  assert.ok(formatMentionedFiles([{ path: 'b.txt', text: big }]).text.includes(`показаны первые ${MAX_MENTION_FILE_CHARS} символов`));
  const many = Array.from({ length: Math.ceil(MAX_MENTION_TOTAL_CHARS / MAX_MENTION_FILE_CHARS) + 1 }, (_, i) => ({ path: `f${i}.txt`, text: big }));
  const r = formatMentionedFiles(many);
  assert.ok(r.skipped.length > 0);
  assert.ok(r.text.includes('Не приложены из-за объёма'));
  assert.deepEqual(formatMentionedFiles([]), { text: '', skipped: [] });
});

test('withFolders: все папки путей с «/» на конце, без повторов', () => {
  assert.deepEqual(withFolders(['a/b/c.bsl', 'a/d.md', 'e.txt']), ['a/b/c.bsl', 'a/d.md', 'e.txt', 'a/', 'a/b/']);
});

test('resolveMention: папка по пути, с «/» и без, по имени; «/» на конце — только папка', () => {
  const paths = withFolders([...PATHS, 'src/cf/Catalogs/Клиенты.xml']);
  assert.deepEqual(resolveMention('src/cf/Catalogs/Клиенты', paths), { path: 'src/cf/Catalogs/Клиенты/' });
  assert.deepEqual(resolveMention('src/cf/Catalogs/Клиенты/', paths), { path: 'src/cf/Catalogs/Клиенты/' });
  assert.deepEqual(resolveMention('Заявка', paths), { path: 'src/cf/Documents/Заявка/' });
  assert.deepEqual(resolveMention('Catalogs/', paths), { path: 'src/cf/Catalogs/' });
  assert.deepEqual(resolveMention('Ext/', paths), {
    candidates: ['src/cf/Catalogs/Клиенты/Ext/', 'src/cf/Documents/Заявка/Ext/', 'src/cf/CommonModules/ОбщегоНазначения/Ext/'],
  });
  assert.deepEqual(resolveMention('README.md', paths), { path: 'README.md' });
});

test('rankPaths: папки в подсказках, точное имя папки выше', () => {
  const paths = withFolders(PATHS);
  assert.equal(rankPaths('заявка', paths)[0], 'src/cf/Documents/Заявка/');
  assert.deepEqual(rankPaths('', paths, 3), ['src/', 'docs/', 'README.md']);
});

test('folderFiles: файлы папки, описания и верхние уровни первыми, без вложенных папок', () => {
  const paths = withFolders(['p/z.bsl', 'p/sub/a.bsl', 'p/README.md', 'p/sub/notes.md', 'q/x.bsl']);
  assert.deepEqual(folderFiles('p/', paths), ['p/README.md', 'p/sub/notes.md', 'p/z.bsl', 'p/sub/a.bsl']);
  assert.deepEqual(folderFiles('p/sub/', paths), ['p/sub/notes.md', 'p/sub/a.bsl']);
});

test('formatMentionedFiles: непрочитанные файлы папки — в списке неприложенных, длинный список сокращается', () => {
  const notRead = Array.from({ length: 250 }, (_, i) => `p/f${i}.bsl`);
  const r = formatMentionedFiles([{ path: 'a.bsl', text: 'x' }], notRead);
  assert.equal(r.skipped.length, 250);
  assert.ok(r.text.includes('… и ещё 50'));
});

test('pickFolderFiles: только целиком и в пределах остатка лимита, большой файл не вытесняет следующие', () => {
  const big = { path: 'f/Form.xml', text: 'x'.repeat(MAX_MENTION_FILE_CHARS + 1) };
  const mid = { path: 'f/b.bsl', text: 'x'.repeat(80) };
  const small = { path: 'f/c.bsl', text: 'x'.repeat(30) };
  const r = pickFolderFiles([{ path: 'f/a.bsl', text: 'x'.repeat(50) }, big, mid, small], 100);
  assert.deepEqual(r.picked.map((f) => f.path), ['f/a.bsl', 'f/c.bsl']);
  assert.deepEqual(r.skipped, ['f/Form.xml', 'f/b.bsl']);
  assert.deepEqual(pickFolderFiles([small], -5), { picked: [], skipped: ['f/c.bsl'] });
});

test('shortNames: одинаковые имена файлов различаются хвостом пути, папка — с «/»', () => {
  assert.deepEqual(
    shortNames(['Catalogs/Склады/Ext/ObjectModule.bsl', 'Documents/Заказ/Ext/ObjectModule.bsl', 'CommonModules/У/Ext/Module.bsl', 'Documents/Заказ/']),
    ['Склады/Ext/ObjectModule.bsl', 'Заказ/Ext/ObjectModule.bsl', 'Module.bsl', 'Заказ/'],
  );
  assert.deepEqual(shortNames(['a/x.bsl', 'x.bsl']), ['a/x.bsl', 'x.bsl']);
});

test('formatSelection: папки и файлы, выбранные пользователем, называются явно', () => {
  assert.equal(formatSelection([]), '');
  const text = formatSelection(['src/', '.vscode/', 'a.bsl']);
  assert.ok(text.includes('папки (2): src/, .vscode/'));
  assert.ok(text.includes('файлы (1): a.bsl'));
  assert.ok(text.includes('файлы папок приложены выше'));
  assert.ok(!formatSelection(['a.bsl']).includes('папк'));
});

test('фрагмент файла: ключ, разбор, строки с сохранением CRLF, подпись для модели', () => {
  const key = fragmentKey('src/a.bsl', 2, 3);
  assert.equal(key, 'src/a.bsl#L2-3');
  assert.deepEqual(parseFragment(key), { path: 'src/a.bsl', from: 2, to: 3 });
  assert.equal(parseFragment('src/a.bsl'), undefined);
  assert.equal(parseFragment('src/'), undefined);
  assert.equal(sliceLines('a\r\nb\r\nc\r\nd', 2, 3), 'b\r\nc');
  assert.equal(attachmentLabel(key), 'src/a.bsl (строки 2–3)');
  assert.equal(attachmentLabel('src/'), 'src/');
  assert.ok(formatSelection([key]).includes('файлы (1): src/a.bsl (строки 2–3)'));
});

test('formatMentionedFiles: фрагмент — с подписью, язык по пути файла', () => {
  const { text } = formatMentionedFiles([{ path: 'a.bsl', text: 'А = 1;', label: 'a.bsl (строки 5–5)' }]);
  assert.ok(text.includes('(1): a.bsl (строки 5–5).'));
  assert.ok(text.includes('--- a.bsl (строки 5–5) ---\n```bsl\nА = 1;'));
});

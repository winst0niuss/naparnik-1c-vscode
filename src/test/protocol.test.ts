import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applySearchReplace, buildAgentPrompt, findUnfinishedWrite, looksLikeMalformedEdit, parseCommands, stripCommandsForDisplay } from '../agent/protocol';

test('команды чтения разбираются в порядке появления', () => {
  const cmds = parseCommands(
    'Сначала посмотрю.\n<list_dir path="src"/>\n<read_file path="src/Модуль.bsl"/>\n<search query="Сообщить" glob="**/*.bsl"/>',
  );
  assert.deepEqual(cmds, [
    { kind: 'list_dir', path: 'src' },
    { kind: 'read_file', path: 'src/Модуль.bsl' },
    { kind: 'search', query: 'Сообщить', glob: '**/*.bsl' },
  ]);
});

test('обычный ответ без команд', () => {
  assert.deepEqual(parseCommands('Модуль проводит документ по регистру.'), []);
});

test('edit_file с несколькими блоками SEARCH/REPLACE, в т.ч. внутри ```', () => {
  const text = [
    '```xml',
    '<edit_file path="src/Модуль.bsl">',
    '<<<<<<< SEARCH',
    'Сообщить("А");',
    '=======',
    'Сообщить("Б");',
    '>>>>>>> REPLACE',
    '<<<<<<< SEARCH',
    'Возврат 1;',
    '=======',
    'Возврат 2;',
    '>>>>>>> REPLACE',
    '</edit_file>',
    '```',
  ].join('\n');
  assert.deepEqual(parseCommands(text), [
    {
      kind: 'edit_file',
      path: 'src/Модуль.bsl',
      edits: [
        { search: 'Сообщить("А");', replace: 'Сообщить("Б");' },
        { search: 'Возврат 1;', replace: 'Возврат 2;' },
      ],
    },
  ]);
});

test('create_file', () => {
  assert.deepEqual(parseCommands('<create_file path="a/Новый.bsl">\nПроцедура А()\nКонецПроцедуры\n</create_file>'), [
    { kind: 'create_file', path: 'a/Новый.bsl', content: 'Процедура А()\nКонецПроцедуры' },
  ]);
});

test('applySearchReplace сохраняет CRLF и проверяет уникальность', () => {
  const original = 'Процедура А()\r\n\tСообщить("А");\r\nКонецПроцедуры\r\n';
  assert.equal(
    applySearchReplace(original, [{ search: '\tСообщить("А");', replace: '\tСообщить("Б");' }]),
    'Процедура А()\r\n\tСообщить("Б");\r\nКонецПроцедуры\r\n',
  );
  assert.throws(() => applySearchReplace(original, [{ search: 'нет такого', replace: 'x' }]), /не найден/);
  assert.throws(() => applySearchReplace('а\nа\n', [{ search: 'а', replace: 'б' }]), /несколько раз/);
});

test('команды и недописанный тег скрываются при стриме', () => {
  assert.equal(stripCommandsForDisplay('<read_file path="a.bsl"/>\n<rea'), '');
  assert.equal(stripCommandsForDisplay('<edit_file path="a">\n<<<<<<< SEARCH\nx'), '');
  assert.equal(stripCommandsForDisplay('Готово: модуль проводит документ.'), 'Готово: модуль проводит документ.');
});

test('команды в XML-виде с вложенными элементами (так пишет реальная модель)', () => {
  const text = '<read_file>\n<path>src/Documents/Заказ/Ext/ObjectModule.bsl</path>\n</read_file>\n<search><query>Сообщить</query></search>';
  assert.deepEqual(parseCommands(text), [
    { kind: 'read_file', path: 'src/Documents/Заказ/Ext/ObjectModule.bsl' },
    { kind: 'search', query: 'Сообщить', glob: undefined },
  ]);
  assert.equal(stripCommandsForDisplay(text), '');
  assert.deepEqual(parseCommands('<edit_file>\n<path>a.bsl</path>\n<<<<<<< SEARCH\nА\n=======\nБ\n>>>>>>> REPLACE\n</edit_file>'), [
    { kind: 'edit_file', path: 'a.bsl', edits: [{ search: 'А', replace: 'Б' }] },
  ]);
});

test('строчный синтаксис @-команд', () => {
  const text = [
    '```',
    '@list_dir src/Documents',
    '@read_file `src/Documents/Заказ/Ext/ObjectModule.bsl`',
    '@search Сообщить | **/*.bsl',
    '@search ПроверкаЗаполнения',
    '@edit_file src/a.bsl',
    '<<<<<<< SEARCH',
    'А',
    '=======',
    'Б',
    '>>>>>>> REPLACE',
    '@end',
    '@create_file src/Новый.bsl',
    '```bsl',
    'Процедура А()',
    'КонецПроцедуры',
    '```',
    '@end',
    '```',
  ].join('\n');
  assert.deepEqual(parseCommands(text), [
    { kind: 'list_dir', path: 'src/Documents' },
    { kind: 'read_file', path: 'src/Documents/Заказ/Ext/ObjectModule.bsl' },
    { kind: 'search', query: 'Сообщить', glob: '**/*.bsl' },
    { kind: 'search', query: 'ПроверкаЗаполнения', glob: undefined },
    { kind: 'edit_file', path: 'src/a.bsl', edits: [{ search: 'А', replace: 'Б' }] },
    { kind: 'create_file', path: 'src/Новый.bsl', content: 'Процедура А()\nКонецПроцедуры' },
  ]);
  assert.equal(stripCommandsForDisplay(text), '');
  assert.equal(stripCommandsForDisplay('@read_file a.bsl\n@edit_file b.bsl\n<<<<<<< SEARCH\nx'), '');
  assert.equal(stripCommandsForDisplay('@list_dir src\n@rea'), '');
  // Обычный текст с «@» в середине строки — не команда
  assert.deepEqual(parseCommands('Напишите на почту a@b.ru'), []);
});

test('findUnfinishedWrite: прогресс записи файла во время стрима', () => {
  assert.deepEqual(findUnfinishedWrite('@create_file docs/A.md\n# Заголовок\nтекст'), { path: 'docs/A.md', chars: 17, isNew: true });
  assert.equal(findUnfinishedWrite('@create_file docs/A.md\n# Заголовок\n@end\nГотово'), undefined);
  assert.equal(findUnfinishedWrite('@read_file a.bsl'), undefined);
  assert.equal(findUnfinishedWrite('@edit_file `src/a.bsl`\n<<<<<<< SEARCH')?.path, 'src/a.bsl');
});

test('контекст проекта попадает в первое сообщение: правила раньше документации', () => {
  const prompt = buildAgentPrompt({ text: 'src/', complete: true }, 'Вопрос', {
    docs: ['README.md', 'CLAUDE.md', 'docs/big.md'],
    attached: [{ path: 'README.md', text: '# Проект' }],
    rules: [{ path: '.rules/git.md', text: '- коммиты на русском' }],
  });
  assert.ok(prompt.indexOf('.rules/git.md') < prompt.indexOf('--- README.md ---'));
  assert.ok(prompt.includes('Ещё есть (читай через @read_file, когда нужно): CLAUDE.md, docs/big.md'));
  assert.ok(prompt.trimEnd().endsWith('Вопрос пользователя: Вопрос'));
});

test('блок без @end закрывается следующей @-командой (так пишет реальная модель)', () => {
  const text = [
    '@create_file .rules/a.md',
    '# А',
    '- правило',
    '@create_file .rules/b.md',
    '# Б',
    '@edit_file .rules/c.md',
    '<<<<<<< SEARCH',
    'x',
    '=======',
    'y',
    '>>>>>>> REPLACE',
  ].join('\n');
  assert.deepEqual(parseCommands(text), [
    { kind: 'create_file', path: '.rules/a.md', content: '# А\n- правило' },
    { kind: 'create_file', path: '.rules/b.md', content: '# Б' },
    { kind: 'edit_file', path: '.rules/c.md', edits: [{ search: 'x', replace: 'y' }] },
  ]);
});

test('create_file с SEARCH/REPLACE внутри и правка без @edit_file', () => {
  const text = '@create_file .rules/a.md\n<<<<<<< SEARCH\n\n=======\n# Стиль\n- правило\n>>>>>>> REPLACE\n@end';
  assert.deepEqual(parseCommands(text), [{ kind: 'create_file', path: '.rules/a.md', content: '# Стиль\n- правило' }]);
  assert.equal(looksLikeMalformedEdit('Вот правка:\n<<<<<<< SEARCH\nа\n=======\nб\n>>>>>>> REPLACE'), true);
  assert.equal(looksLikeMalformedEdit('@edit_file a.md\n<<<<<<< SEARCH\nа\n=======\nб\n>>>>>>> REPLACE\n@end'), false);
});

test('строка «@read_file …» внутри текста файла не обрывает блок, если есть @end', () => {
  const text = '@create_file NAPARNIK.md\n# Команды\n@read_file путь — прочитать файл\n@search текст\nКонец\n@end\nГотово.';
  assert.deepEqual(parseCommands(text), [
    { kind: 'create_file', path: 'NAPARNIK.md', content: '# Команды\n@read_file путь — прочитать файл\n@search текст\nКонец' },
  ]);
});

test('«@end» в той же строке, что и команда чтения, — не часть пути', () => {
  assert.deepEqual(parseCommands('@read_file service-a/README.md @end\n@list_dir src @end\n@search Dockerfile @end'), [
    { kind: 'read_file', path: 'service-a/README.md' },
    { kind: 'list_dir', path: 'src' },
    { kind: 'search', query: 'Dockerfile', glob: undefined },
  ]);
});

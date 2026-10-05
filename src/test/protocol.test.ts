import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { applySearchReplace, parseCommands, stripCommandsForDisplay } from '../agent/protocol';

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

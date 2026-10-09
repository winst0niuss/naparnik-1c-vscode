import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import {
  applySearchReplace,
  buildAgentPrompt,
  emulatedCommand,
  changedCode,
  describeCommand,
  findUnfinishedWrite,
  isBslPath,
  looksLikeMalformedEdit,
  parseCommands,
  stripCommandsForDisplay,
  syntaxCheckRequest,
} from '../agent/protocol';

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

test('перенос, копирование, удаление: разделители «|», «->», «→», два пути через пробел', () => {
  const cmds = parseCommands(
    [
      '@move_file src/a.bsl | src/b/a.bsl',
      '@move_file `x.md` -> docs/',
      '@copy_file a.txt → b.txt',
      '@copy_file one.md two.md',
      '@delete_file old/Модуль.bsl @end',
      '@move_file только-один-путь',
    ].join('\n'),
  );
  assert.deepEqual(cmds, [
    { kind: 'move_file', from: 'src/a.bsl', to: 'src/b/a.bsl' },
    { kind: 'move_file', from: 'x.md', to: 'docs/' },
    { kind: 'copy_file', from: 'a.txt', to: 'b.txt' },
    { kind: 'copy_file', from: 'one.md', to: 'two.md' },
    { kind: 'delete_file', path: 'old/Модуль.bsl' },
  ]);
  assert.equal(stripCommandsForDisplay('Переношу.\n@move_file a | b\n@delete_file c'), 'Переношу.');
  assert.equal(describeCommand({ kind: 'move_file', from: 'a', to: 'b' }), '🚚 Предлагаю перенести a → b');
});

const MODULE = [
  'Перем мКэш;',
  '',
  '&НаСервере',
  'Процедура Первая()',
  '\tА = 1;',
  'КонецПроцедуры',
  '',
  'Функция Вторая(П) Экспорт',
  '\tВозврат П + 1;',
  'КонецФункции',
  '',
  'Процедура Третья()',
  '\tБ = 2;',
  'КонецПроцедуры',
].join('\r\n');

test('changedCode: изменённые процедуры целиком, с директивой; правка вне процедур — весь модуль', () => {
  assert.equal(changedCode(MODULE, ['\tА = 1;']), '&НаСервере\nПроцедура Первая()\n\tА = 1;\nКонецПроцедуры');
  // Две правки в разных процедурах — обе, по порядку, без лишней между ними
  assert.equal(
    changedCode(MODULE, ['\tБ = 2;', '\tА = 1;']),
    '&НаСервере\nПроцедура Первая()\n\tА = 1;\nКонецПроцедуры\n\nПроцедура Третья()\n\tБ = 2;\nКонецПроцедуры',
  );
  assert.equal(changedCode(MODULE, ['Перем мКэш;']), MODULE.replace(/\r\n/g, '\n'));
  assert.equal(changedCode(MODULE, ['нет такого']), undefined);
  // Файл изменился после правки (форматирование) — фрагмент находится по первой строке
  assert.equal(changedCode(MODULE, ['Процедура Третья()\n    Б = 2;']), 'Процедура Третья()\n\tБ = 2;\nКонецПроцедуры');
  assert.equal(changedCode(MODULE, ['']), undefined);
  assert.equal(changedCode('Процедура А()\n' + 'х = 1;\n'.repeat(5000) + 'КонецПроцедуры', ['х = 1;']), undefined, 'слишком большой фрагмент не проверяем');
  assert.ok(isBslPath('Ext/Module.bsl') && isBslPath('a.os') && !isBslPath('a.md'));
  assert.match(syntaxCheckRequest('m.bsl', 'КОД'), /mcp__syntax-checker__validate[\s\S]*```bsl\nКОД\n```$/);
});

test('блок правки, закрытый «=======» вместо «>>>>>>> REPLACE» или не закрытый (так пишет реальная модель)', () => {
  const closedBySeparator = parseCommands('@edit_file m.bsl\n<<<<<<< SEARCH\nА = 1;\n=======\nА = 2;\nБ = 3;\n=======\n@end');
  assert.deepEqual(closedBySeparator, [{ kind: 'edit_file', path: 'm.bsl', edits: [{ search: 'А = 1;', replace: 'А = 2;\nБ = 3;' }] }]);
  const unclosed = parseCommands('@edit_file m.bsl\n<<<<<<< SEARCH\nА = 1;\n=======\nА = 2;\n@end');
  assert.deepEqual(unclosed, [{ kind: 'edit_file', path: 'm.bsl', edits: [{ search: 'А = 1;', replace: 'А = 2;' }] }]);
  const two = parseCommands('@edit_file m.bsl\n<<<<<<< SEARCH\nА\n=======\nБ\n<<<<<<< SEARCH\nВ\n=======\nГ\n@end');
  assert.deepEqual(two[0].kind === 'edit_file' && two[0].edits, [{ search: 'А', replace: 'Б' }, { search: 'В', replace: 'Г' }]);
});

test('ReadSystemFile и WriteSystemFile выполняются как @-команды, остальные инструменты EDT — нет', () => {
  const call = (name: string, args: object | string) => ({ function: { name, arguments: typeof args === 'string' ? args : JSON.stringify(args) } });
  assert.deepEqual(emulatedCommand(call('ReadSystemFile', { path: 'attachment://README.md' })), { kind: 'read_file', path: 'README.md' });
  assert.deepEqual(emulatedCommand(call('ReadSystemFile', { file_path: 'src/a.bsl' })), { kind: 'read_file', path: 'src/a.bsl' });
  // ReadResource — с путями проекта под разными схемами (живой API, /init)
  assert.deepEqual(emulatedCommand(call('ReadResource', { path: 'memory://CLAUDE.md' })), { kind: 'read_file', path: 'CLAUDE.md' });
  assert.deepEqual(emulatedCommand(call('ReadResource', { path: 'attachment://playwright/package.json' })), { kind: 'read_file', path: 'playwright/package.json' });
  assert.equal(emulatedCommand(call('ReadSystemFile', 'не json')), undefined);
  assert.equal(emulatedCommand(call('ReadSystemFile', { path: '129a6f8e-8537-4e9e-9b4d-0a36ea6d37ee' })), undefined);
  assert.deepEqual(emulatedCommand(call('WriteSystemFile', { path: 'NAPARNIK.md', content: '# Проект' })), { kind: 'create_file', path: 'NAPARNIK.md', content: '# Проект' });
  assert.equal(emulatedCommand(call('WriteSystemFile', { path: 'a.md' })), undefined);
  assert.equal(emulatedCommand(call('Task', { prompt: 'изучи проект' })), undefined);
});

test('git-команды: строки с аргументами и коммит блоком до @end', () => {
  const cmds = parseCommands(
    ['@git_status', '@git_diff src/Модуль.bsl', '@git_log 5', '@git_branch', '@git_create_branch feature/x', '@git_checkout dev',
      '@git_commit', 'fix: исправлена проводка', '', '- подробности', '@end', '@git_pull', '@git_push'].join('\n'),
  );
  assert.deepEqual(cmds, [
    { kind: 'git_status' },
    { kind: 'git_diff', path: 'src/Модуль.bsl' },
    { kind: 'git_log', count: 5 },
    { kind: 'git_branch' },
    { kind: 'git_create_branch', name: 'feature/x' },
    { kind: 'git_checkout', branch: 'dev' },
    { kind: 'git_commit', message: 'fix: исправлена проводка\n\n- подробности' },
    { kind: 'git_pull' },
    { kind: 'git_push' },
  ]);
});

test('git_log: число и файл в разных записях', () => {
  assert.deepEqual(parseCommands('@git_log 1 | src/fixtures/esb.fixture.ts'), [{ kind: 'git_log', count: 1, path: 'src/fixtures/esb.fixture.ts' }]);
  assert.deepEqual(parseCommands('@git_log src/a.ts'), [{ kind: 'git_log', path: 'src/a.ts' }]);
  assert.deepEqual(parseCommands('@git_log -n 3 -- src/a.ts'), [{ kind: 'git_log', count: 3, path: 'src/a.ts' }]);
  assert.deepEqual(parseCommands('@git_log -1 "src/a b.ts"'), [{ kind: 'git_log', count: 1, path: 'src/a b.ts' }]);
  assert.deepEqual(parseCommands('@git_log --oneline -n5'), [{ kind: 'git_log', count: 5 }]);
  assert.deepEqual(parseCommands('@git_log --max-count=3'), [{ kind: 'git_log', count: 3 }]);
});

test('git_commit: сообщение в той же строке; блок без @end закрывает следующая команда', () => {
  assert.deepEqual(parseCommands('@git_commit feat: новое'), [{ kind: 'git_commit', message: 'feat: новое' }]);
  assert.deepEqual(parseCommands('@git_commit\nfix: x\n@git_push'), [{ kind: 'git_commit', message: 'fix: x' }, { kind: 'git_push' }]);
  // Без аргумента команды, которым он нужен, не выполняются; неизвестные git-команды — не наши
  assert.deepEqual(parseCommands('@git_checkout\n@git_reset --hard'), []);
});

test('git-команды скрываются из текста ответа', () => {
  assert.equal(stripCommandsForDisplay('Смотрю изменения.\n@git_status\n@git_diff\n@git_commit\nfix: x\n@end'), 'Смотрю изменения.');
  assert.equal(stripCommandsForDisplay('Готово.\n@git_commit feat: y'), 'Готово.');
});

test('команды git в промпте — только для проекта в репозитории', () => {
  const tree = { text: 'a.bsl', complete: true };
  assert.ok(!buildAgentPrompt(tree, 'вопрос').includes('@git_status'));
  assert.ok(buildAgentPrompt(tree, 'вопрос', undefined, true).includes('@git_status'));
});

test('описание git-шагов', () => {
  assert.equal(describeCommand({ kind: 'git_commit', message: 'fix: x\n\nописание' }), '🔀 Предлагаю коммит «fix: x»');
  assert.equal(describeCommand({ kind: 'git_diff', path: 'a.bsl' }), '🔀 git diff a.bsl');
});

test('git-команды в стиле CLI: -m у коммита, -b у checkout, флаги diff, push/pull с флагами', () => {
  assert.deepEqual(parseCommands('@git_commit -m "fix: x"'), [{ kind: 'git_commit', message: 'fix: x' }]);
  assert.deepEqual(parseCommands("@git_commit -am 'feat: y'"), [{ kind: 'git_commit', message: 'feat: y' }]);
  assert.deepEqual(parseCommands('@git_checkout -b feature/x'), [{ kind: 'git_create_branch', name: 'feature/x' }]);
  assert.deepEqual(parseCommands('@git_diff --staged\n@git_diff --cached a.bsl'), [{ kind: 'git_diff' }, { kind: 'git_diff', path: 'a.bsl' }]);
  assert.deepEqual(parseCommands('@git_push origin main\n@git_push --force\n@git_pull --rebase'), [
    { kind: 'git_push' },
    { kind: 'git_push', flags: '--force' },
    { kind: 'git_pull', flags: '--rebase' },
  ]);
});

test('сравнение «<» в коде ответа не обрезает текст', () => {
  const text = 'Проблема:\n```bsl\nЕсли Остаток < Количество Тогда\n\tОтказ = Истина;\n```\nДобавьте Прервать.';
  assert.equal(stripCommandsForDisplay(text), text);
  assert.equal(stripCommandsForDisplay('Смотрю.\n<read_fi'), 'Смотрю.');
});

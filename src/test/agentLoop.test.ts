import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentClient, FINISH_HINT, looksLikeUnfinishedIntent, runAgentLoop } from '../agent/agentLoop';
import { AgentCommand, parseCommands } from '../agent/protocol';

/** Мок модели: отвечает заранее заданными текстами и запоминает, что ей прислали */
function scriptedClient(replies: string[]) {
  const sent: string[] = [];
  const client: AgentClient = {
    async sendMessage(_conv, message) {
      sent.push(message);
      const text = replies[Math.min(sent.length - 1, replies.length - 1)];
      return { text, assistantUuid: `u${sent.length}` };
    },
  };
  return { client, sent };
}

function tools() {
  const ran: AgentCommand[] = [];
  return { ran, tools: { run: async (c: AgentCommand) => (ran.push(c), `ок ${c.kind}`) } };
}

const base = { conversationId: 'c', parentUuid: undefined, message: 'вопрос', signal: new AbortController().signal, onText: () => {} };

test('обычный цикл: команды → результаты → ответ', async () => {
  const { client, sent } = scriptedClient(['@read_file a.ts\n@read_file b.ts', 'Готово']);
  const t = tools();
  const r = await runAgentLoop({ ...base, client, tools: t.tools, maxSteps: 12 });
  assert.equal(r.text, 'Готово');
  assert.equal(r.steps, 1);
  assert.equal(t.ran.length, 2, 'обе команды из одного ответа выполнены за один шаг');
  assert.ok(sent[1].startsWith('Результаты команд:'));
});

test('лимит шагов: модель получает FINISH_HINT и создаёт файл, а не падает', async () => {
  // Модель всё время читает, а после подсказки — создаёт файл и отвечает
  const replies = [...Array(3).fill('@read_file x.ts'), '@read_file y.ts\n@create_file NAPARNIK.md\n# Проект\n@end', 'Создал NAPARNIK.md'];
  const { client, sent } = scriptedClient(replies);
  const t = tools();
  const r = await runAgentLoop({ ...base, client, tools: t.tools, maxSteps: 3 });
  assert.equal(r.text, 'Создал NAPARNIK.md');
  assert.equal(r.finishedByLimit, true);
  assert.ok(sent[3].includes(FINISH_HINT), 'подсказка уходит после последнего обычного шага');
  // После подсказки чтение не выполняется, создание файла — да
  assert.deepEqual(t.ran.slice(3).map((c) => c.kind), ['create_file']);
  assert.ok(sent[4].includes('итоговый ответ без команд'));
});

test('после подсказки модель продолжает только читать — понятная ошибка', async () => {
  const { client } = scriptedClient(['@list_dir src']);
  await assert.rejects(runAgentLoop({ ...base, client, tools: tools().tools, maxSteps: 2 }), /не уложился в 2 шагов/);
});

test('правка без @edit_file — одно напоминание о формате', async () => {
  const { client, sent } = scriptedClient(['<<<<<<< SEARCH\nа\n=======\nб\n>>>>>>> REPLACE', 'Ответ']);
  const r = await runAgentLoop({ ...base, client, tools: tools().tools, maxSteps: 12 });
  assert.equal(r.text, 'Ответ');
  assert.ok(sent[1].includes('@edit_file'));
});

test('без инструментов команды не выполняются — ответ как есть', async () => {
  const { client } = scriptedClient(['@read_file a.ts']);
  const r = await runAgentLoop({ ...base, client, maxSteps: 12 });
  assert.equal(r.text, '@read_file a.ts');
});

test('@list_dir с глубиной', () => {
  assert.deepEqual(parseCommands('@list_dir tests | 3\n@list_dir src\n@list_dir . | 9'), [
    { kind: 'list_dir', path: 'tests', depth: 3 },
    { kind: 'list_dir', path: 'src' },
    { kind: 'list_dir', path: '.', depth: 4 },
  ]);
});

test('ответ-намерение без команд → напоминание продолжить командами', async () => {
  const { client, sent } = scriptedClient(['Хорошо, теперь читаю package.json и tsconfig.json.', '@read_file package.json', 'Готово: проект на TypeScript.']);
  const t = tools();
  const r = await runAgentLoop({ ...base, client, tools: t.tools, maxSteps: 12 });
  assert.equal(r.text, 'Готово: проект на TypeScript.');
  assert.ok(sent[1].includes('не прислал команд'));
  assert.deepEqual(t.ran.map((c) => c.kind), ['read_file']);
});

test('checkDone: /init без NAPARNIK.md не считается выполненным (не больше двух напоминаний)', async () => {
  const { client, sent } = scriptedClient(['Изучил проект, вот описание…', '@create_file NAPARNIK.md\n# П\n@end', 'Создал файл.']);
  const t = tools();
  const checkDone = (ex: AgentCommand[]) => (ex.some((c) => c.kind === 'create_file') ? undefined : 'NAPARNIK.md ещё не создан');
  const r = await runAgentLoop({ ...base, client, tools: t.tools, maxSteps: 12, checkDone });
  assert.equal(r.text, 'Создал файл.');
  assert.ok(sent[1].includes('ещё не создан'));
  // Модель упорно не создаёт файл — после двух напоминаний отдаём её ответ как есть
  const stubborn = scriptedClient(['Не буду создавать.']);
  const r2 = await runAgentLoop({ ...base, client: stubborn.client, tools: tools().tools, maxSteps: 12, checkDone });
  assert.equal(r2.text, 'Не буду создавать.');
  assert.equal(stubborn.sent.length, 3);
});

test('обычный развёрнутый ответ — без напоминаний', async () => {
  const { client, sent } = scriptedClient(['Модуль проводит документ по регистру ТоварыНаСкладах. Ошибок не вижу.']);
  await runAgentLoop({ ...base, client, tools: tools().tools, maxSteps: 12 });
  assert.equal(sent.length, 1);
});

test('looksLikeUnfinishedIntent: намерения ловим, завершённые ответы — нет', async () => {
  const { looksLikeUnfinishedIntent } = await import('../agent/agentLoop');
  for (const t of ['Хорошо, теперь читаю package.json и tsconfig.json.', 'Сейчас посмотрю структуру tests.', 'Далее изучу фикстуры:', 'Понял. Проверю конфигурацию сборки.'])
    assert.ok(looksLikeUnfinishedIntent(t), t);
  for (const t of ['Отлично, файл NAPARNIK.md создан.', 'Хорошо, правка применена.', 'Итак, модуль проводит документ по регистру ТоварыНаСкладах.', 'Готово: добавлена проверка количества.', 'Модуль выводит сообщение пользователю.'])
    assert.ok(!looksLikeUnfinishedIntent(t), t);
});

test('проверка синтаксиса: после применённой правки .bsl модель получает изменённую процедуру', async () => {
  const module = 'Процедура А()\n\tх = 1;\nКонецПроцедуры\n\nПроцедура Б()\nКонецПроцедуры';
  const edit = '@edit_file M.bsl\n<<<<<<< SEARCH\n\tх = 0;\n=======\n\tх = 1;\n>>>>>>> REPLACE\n@end';
  const { client, sent } = scriptedClient([edit, 'Готово, ошибок нет']);
  const agentTools = {
    run: async (c: AgentCommand) => (c.kind === 'edit_file' ? `Правка ${c.path} применена.` : 'ок'),
    readFileText: async () => module,
  };
  await runAgentLoop({ ...base, client, tools: agentTools, maxSteps: 12 });
  assert.match(sent[1], /mcp__syntax-checker__validate/);
  assert.ok(sent[1].includes('```bsl\nПроцедура А()\n\tх = 1;\nКонецПроцедуры\n```'), 'только изменённая процедура');
});

test('проверка синтаксиса не просится: правка отклонена, не BSL или нет чтения файла', async () => {
  const edit = (p: string) => `@edit_file ${p}\n<<<<<<< SEARCH\nа\n=======\nб\n>>>>>>> REPLACE\n@end`;
  const cases: [string, (c: AgentCommand) => string, boolean][] = [
    ['M.bsl', () => 'Пользователь отклонил правку M.bsl.', true],
    ['a.md', (c) => `Правка ${'path' in c ? c.path : ''} применена.`, true],
    ['M.bsl', () => 'Правка M.bsl применена.', false],
  ];
  for (const [path, result, canRead] of cases) {
    const { client, sent } = scriptedClient([edit(path), 'Готово']);
    const agentTools = { run: async (c: AgentCommand) => result(c), ...(canRead ? { readFileText: async () => 'б' } : {}) };
    await runAgentLoop({ ...base, client, tools: agentTools, maxSteps: 12 });
    assert.doesNotMatch(sent[1], /syntax-checker/, path);
  }
});

test('короткий ответ, оборванный на двоеточии, — намерение: модель получает напоминание', async () => {
  assert.ok(looksLikeUnfinishedIntent('Использую @-команды:'));
  assert.ok(!looksLikeUnfinishedIntent('Ответ: 42'));
  assert.ok(looksLikeUnfinishedIntent('Вижу текущую процедуру `ОбработкаПроведения`. Нужно добавить проверку заполнения реквизита `Клиент`.'));
  assert.ok(!looksLikeUnfinishedIntent('Проверка добавлена в ОбработкаПроведения.'));
  const { client, sent } = scriptedClient(['Использую @-команды:', '@read_file a.bsl', 'Готово']);
  const t = tools();
  const r = await runAgentLoop({ ...base, client, tools: t.tools, maxSteps: 12 });
  assert.equal(r.text, 'Готово');
  assert.equal(t.ran.length, 1);
  assert.match(sent[1], /не прислал команд/);
});

test('вызов инструмента текстом («@validate code=…») — напоминание, а не итоговый ответ', async () => {
  const { client, sent } = scriptedClient(['@validate code="Процедура А()\nКонецПроцедуры"', 'Синтаксис проверен, ошибок нет']);
  const t = tools();
  const r = await runAgentLoop({ ...base, client, tools: t.tools, maxSteps: 12 });
  assert.equal(r.text, 'Синтаксис проверен, ошибок нет');
  assert.equal(t.ran.length, 0);
  assert.match(sent[1], /написал его текстом/);
});

test('looksLikeTextToolCall: вызовы инструментов текстом, но не обычный ответ', async () => {
  const { looksLikeTextToolCall } = await import('../agent/protocol');
  for (const t of ['@validate code="x"', "@TodoWrite todos=[{'content': 'a'}]", 'mcp__syntax-checker__validate(code="x")']) assert.ok(looksLikeTextToolCall(t), t);
  for (const t of ['Готово, файл создан.', '@read_file a.md', 'Используйте @read_file для чтения']) assert.ok(!looksLikeTextToolCall(t), t);
});

test('вызов проверки синтаксиса текстом: напоминание повторяет код из файла, а не версию модели', async () => {
  const { client, sent } = scriptedClient([
    '@edit_file m.bsl\n<<<<<<< SEARCH\nА = 1;\n=======\nА = 2;\n>>>>>>> REPLACE\n@end',
    '@validate code="Процедура П()\nА = 2;\nКонецПроцедуры"',
    'Ошибок нет',
  ]);
  const fileText = 'Процедура П()\nА = 2;\nКонецПроцедур\n';
  const tools = { run: async () => 'Правка m.bsl применена.', readFileText: async () => fileText };
  await runAgentLoop({ ...base, client, tools, maxSteps: 12 });
  assert.match(sent[2], /написал его текстом/);
  assert.ok(sent[2].includes('```bsl\nПроцедура П()\nА = 2;\nКонецПроцедур\n'), 'в напоминании — текст из файла');
  assert.ok(!sent[2].includes('КонецПроцедуры'), 'не версия модели');
});

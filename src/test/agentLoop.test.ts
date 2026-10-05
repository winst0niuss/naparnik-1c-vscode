import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { AgentClient, FINISH_HINT, runAgentLoop } from '../agent/agentLoop';
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

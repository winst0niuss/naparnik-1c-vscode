import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SseParser, stripThinkingTags } from '../api/sseParser';

function parse(...events: object[]) {
  const parser = new SseParser();
  for (const e of events) {
    parser.feedLine('data: ' + JSON.stringify(e));
  }
  return parser;
}

test('content_delta накапливается построчно', () => {
  const p = parse({ content_delta: 'Привет, ' }, { content_delta: { content: 'мир' } });
  assert.equal(p.visibleText, 'Привет, мир');
  assert.equal(p.result().text, 'Привет, мир');
});

test('финальный content.content важнее накопленных дельт', () => {
  const p = parse({ content_delta: { content: 'черно' } }, { role: 'assistant', uuid: 'a-1', content: { content: 'итог' }, content_delta: { content: 'вик' }, finished: true });
  assert.equal(p.result().text, 'итог');
  assert.equal(p.result().assistantUuid, 'a-1');
});

test('echo вопроса пользователя пропускается', () => {
  const p = parse({ role: 'user', uuid: 'u-1', finished: true, content: null }, { role: 'assistant', uuid: 'a-1', content: { content: 'ответ' }, finished: true });
  assert.equal(p.result().text, 'ответ');
  assert.equal(p.result().assistantUuid, 'a-1');
});

test('результат инструмента после ACK пропускается, ждём ответ ассистента', () => {
  // Структура взята из реального ответа code.1c.ai
  const p = parse(
    { role: 'tool', type: 'tool', content: { type: 'tool', content: '{"content":"Найдено 10 результатов"}' }, finished: true },
    { uuid: 'a-2', role: 'assistant', content: null, finished: false },
    { uuid: 'a-2', role: null, content_delta: { content: 'Нашёл ' } },
    { uuid: 'a-2', role: null, content_delta: { content: 'стандарт' } },
    { uuid: 'a-2', role: 'assistant', content: { content: 'Нашёл стандарт', tool_calls: null }, finished: true },
  );
  assert.equal(p.result().text, 'Нашёл стандарт');
  assert.equal(p.result().hasToolCalls, false);
});

test('tool_calls из итогового события', () => {
  const call = { id: 'call-1', function: { name: 'mcp__knowledge-hub__Search_ITS', arguments: '{"query":"x"}' }, type: 'function' };
  const p = parse(
    { uuid: 'a-1', role: null, content_delta: { content: '', tool_calls: [{ index: 0, ...call }] } },
    { uuid: 'a-1', role: 'assistant', content: { content: '', tool_calls: [call] }, finished: true },
  );
  assert.ok(p.result().hasToolCalls);
  assert.deepEqual(p.result().toolCalls, [call]);
});

test('несколько ответов в одном потоке: итог — последний (сервер сам отклонил неизвестный инструмент)', () => {
  // Наблюдалось на живом API: вызов «Search_ITS» без префикса, сервер ответил «unknown tool» и продолжил
  const p = parse(
    { uuid: 'a-1', role: null, content_delta: { content: '', tool_calls: [{ index: 0, id: 'call-x', function: { name: 'Search_ITS' } }] } },
    { uuid: 'a-1', role: 'assistant', content: { content: '', tool_calls: null }, finished: true },
    { uuid: 't-1', role: 'tool', content: { content: "'Search_ITS' is unknown tool." }, finished: true },
    { uuid: 'a-2', role: 'assistant', content: null, finished: false },
    { uuid: 'a-2', role: null, content_delta: { content: 'Ответ' } },
    { uuid: 'a-2', role: 'assistant', content: { content: 'Ответ без поиска' }, finished: true },
  );
  const r = p.result();
  assert.equal(r.text, 'Ответ без поиска');
  assert.equal(r.hasToolCalls, false);
  assert.deepEqual(r.toolCalls, []);
  assert.equal(r.assistantUuid, 'a-2');
});

test('heartbeat и мусорные строки не ломают парсер', () => {
  const p = new SseParser();
  p.feedLine(': heartbeat 1791277585183');
  p.feedLine('data: не json');
  p.feedLine('data: {"content_delta":"ок"}');
  assert.equal(p.result().text, 'ок');
});

test('только reasoning без текста помечается', () => {
  const p = parse({ content_delta: { content: '', reasoning_content: 'хм' } });
  assert.ok(p.result().hasOnlyReasoning);
});

test('thinking-теги вырезаются, незакрытый скрывается при стриминге', () => {
  assert.equal(stripThinkingTags('<think>скрыто</think>Ответ'), 'Ответ');
  assert.equal(stripThinkingTags('Ответ<thinking>пишется...', true), 'Ответ');
});

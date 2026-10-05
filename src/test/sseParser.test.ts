import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { SseParser, stripThinkingTags, unwrapToolResult } from '../api/sseParser';

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

test('финальный content.text важнее накопленных дельт', () => {
  const p = parse({ content_delta: 'черновик' }, { role: 'assistant', content: { text: 'итог' }, finished: true });
  assert.equal(p.result().text, 'итог');
  assert.ok(p.done);
});

test('echo пользователя с finished=true не завершает поток', () => {
  const p = parse({ role: 'user', finished: true, content: { content: { instruction: 'вопрос' } } });
  assert.equal(p.done, false);
  assert.equal(p.result().text, '');
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
  assert.ok(p.done);
  assert.equal(p.result().text, 'Нашёл стандарт');
  assert.equal(p.result().hasToolCalls, false);
});

test('OpenAI-формат: текст и фрагменты tool_calls собираются по index', () => {
  const p = parse(
    { role: 'assistant', uuid: 'a-1' },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call-1', function: { name: 'Search_' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'ITS', arguments: '{"q":' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] } }] },
  );
  const r = p.result();
  assert.ok(r.hasToolCalls);
  assert.equal(r.assistantUuid, 'a-1');
  assert.deepEqual(r.toolCalls, [{ id: 'call-1', function: { name: 'Search_ITS', arguments: '{"q":"x"}' } }]);
});

test('[DONE] и мусорные строки не ломают парсер', () => {
  const p = new SseParser();
  p.feedLine('event: message');
  p.feedLine('data: не json');
  p.feedLine('data: {"content_delta":"ок"}');
  p.feedLine('data: [DONE]');
  p.feedLine('data: {"content_delta":"после конца"}');
  assert.equal(p.result().text, 'ок');
});

test('только reasoning без текста помечается', () => {
  const p = parse({ choices: [{ delta: { reasoning_content: 'хм' } }] });
  assert.ok(p.result().hasOnlyReasoning);
});

test('thinking-теги вырезаются, незакрытый скрывается при стриминге', () => {
  assert.equal(stripThinkingTags('<think>скрыто</think>Ответ'), 'Ответ');
  assert.equal(stripThinkingTags('Ответ<thinking>пишется...', true), 'Ответ');
});

test('unwrapToolResult разворачивает вложенные обёртки', () => {
  const inner = JSON.stringify({ content: [{ type: 'text', text: 'результат' }] });
  assert.equal(unwrapToolResult(JSON.stringify({ content: inner })), 'результат');
  assert.equal(unwrapToolResult('обычный текст'), 'обычный текст');
});

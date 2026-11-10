import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { NaparnikClient, StreamCutError } from '../api/client';

for (const status of [429, 503]) {
  test(`Retry-After дольше таймаута попытки: после HTTP ${status} сообщение успешно повторяется`, async (t) => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
      calls++;
      init?.signal?.throwIfAborted();
      if (calls === 1) return new Response('{}', { status, headers: { 'Retry-After': '1' } });
      return new Response(`data: ${JSON.stringify({ role: 'assistant', uuid: 'a-1', content: { content: 'Готово' }, finished: true })}\n\n`);
    });
    const client = new NaparnikClient({ token: 'test-token', baseUrl: 'https://example.invalid', authFormat: 'plain', skillName: 'custom', timeoutMs: 25 });
    const shown: string[] = [];

    const answer = await client.sendMessage('conv-1', 'Вопрос', 'previous-answer', { onText: (text) => shown.push(text) });

    assert.equal(calls, 2);
    assert.equal(answer.text, 'Готово');
    assert.equal(answer.assistantUuid, 'a-1');
    assert.equal(shown.at(-1), 'Готово');
  });
}

test('обрыв внутри интервала обновления: весь полученный текст передаётся в onText до ошибки', async (t) => {
  // Оба события приходят в один интервал обновления, независимо от скорости машины.
  t.mock.method(Date, 'now', () => 1_000);
  const encoder = new TextEncoder();
  const events = [
    { role: 'assistant', uuid: 'a-1', content_delta: 'Начало' },
    { content_delta: ' и продолжение' },
  ];
  let eventIndex = 0;
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    calls++;
    return new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        if (eventIndex < events.length) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(events[eventIndex++])}\n\n`));
        } else {
          controller.error(new TypeError('terminated'));
        }
      },
    }, { highWaterMark: 0 }));
  });
  const client = new NaparnikClient({ token: 'test-token', baseUrl: 'https://example.invalid', authFormat: 'plain', skillName: 'custom', timeoutMs: 5_000 });
  const shown: string[] = [];

  await assert.rejects(client.sendMessage('conv-1', 'Вопрос', undefined, { onText: (text) => shown.push(text) }), StreamCutError);

  assert.equal(calls, 1, 'после частичного ответа запрос не повторяется');
  assert.equal(eventIndex, events.length);
  assert.equal(shown[0], 'Начало');
  assert.equal(shown.at(-1), 'Начало и продолжение');
});

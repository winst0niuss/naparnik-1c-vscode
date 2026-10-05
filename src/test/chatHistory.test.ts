import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatHistory, createChat, makeTitle } from '../chatHistory';

// Простая замена vscode.Memento на Map
function memento() {
  const data = new Map<string, unknown>();
  return {
    keys: () => [...data.keys()],
    get: <T>(key: string, def?: T) => (data.has(key) ? (data.get(key) as T) : def),
    update: async (key: string, value: unknown) => void data.set(key, value),
  };
}

test('заголовок: первая строка вопроса, код заменяется на [код], длинное обрезается', () => {
  assert.equal(makeTitle('Объясни этот код\n\n```bsl\nПроцедура А()\n```'), 'Объясни этот код [код]');
  assert.equal(makeTitle('а'.repeat(100)).length, 60);
  assert.equal(makeTitle('   '), 'Без названия');
});

test('история: пустые не сохраняются, новые сверху, удаление работает', async () => {
  const history = new ChatHistory(memento() as any);
  const empty = createChat();
  await history.save(empty);
  assert.equal(history.list().length, 0);

  const first = { ...createChat(), title: 'первый', entries: [{ role: 'user' as const, text: '1' }] };
  const second = { ...createChat(), title: 'второй', entries: [{ role: 'user' as const, text: '2' }] };
  await history.save(first);
  await new Promise((r) => setTimeout(r, 2));
  await history.save(second);
  assert.deepEqual(history.list().map((c) => c.title), ['второй', 'первый']);

  // Продолжили старый чат — он поднимается наверх, без дублей
  await new Promise((r) => setTimeout(r, 2));
  await history.save(first);
  assert.deepEqual(history.list().map((c) => c.title), ['первый', 'второй']);

  await history.delete(second.id);
  assert.deepEqual(history.list().map((c) => c.title), ['первый']);
});

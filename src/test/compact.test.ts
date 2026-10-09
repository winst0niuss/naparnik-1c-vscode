import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { ChatEntry } from '../chatHistory';
import { buildTranscript, compactPrompt, compactTranscriptPrompt, isUsableSummary, needsAutoCompact, summaryBlock, userMessages } from '../agent/compact';

test('уточнение пользователя попадает в инструкцию пересказа', () => {
  assert.match(compactPrompt('решения по регистру остатков'), /Обязательно сохрани: решения по регистру остатков$/);
  assert.doesNotMatch(compactPrompt(''), /Обязательно сохрани/);
  assert.match(compactTranscriptPrompt('### Я\nвопрос', 'пути'), /Обязательно сохрани: пути\n\n<разговор>\n### Я\nвопрос\n<\/разговор>$/);
});

test('пересказ: пустой, короткий и отказ сервера не годятся', () => {
  assert.equal(isUsableSummary(''), false);
  assert.equal(isUsableSummary('Цель: ок'), false);
  assert.equal(isUsableSummary('Не удалось сформировать ответ. ' + 'x'.repeat(200)), false);
  assert.equal(isUsableSummary('**Цель** — ' + 'доработать модуль. '.repeat(10)), true);
});

test('пересказ перед вопросом — в тегах, без лишних пробелов', () => {
  assert.match(summaryBlock('  итог  \n'), /<пересказ>\nитог\n<\/пересказ>$/);
});

test('автосжатие: только когда контекст с новым сообщением превысит 85%', () => {
  const limit = 262_144;
  assert.equal(needsAutoCompact(undefined, 1_000_000), false);
  assert.equal(needsAutoCompact({ tokens: 100_000, limit }, 1_000), false);
  assert.equal(needsAutoCompact({ tokens: 220_000, limit }, 1_000), false);
  assert.equal(needsAutoCompact({ tokens: 223_000, limit }, 0), true);
  // 150 тыс. символов приложенных файлов ≈ 65 тыс. токенов
  assert.equal(needsAutoCompact({ tokens: 160_000, limit }, 150_000), true);
});

const entries: ChatEntry[] = [
  { role: 'compact', text: 'Ранний пересказ' },
  { role: 'user', text: 'Цель: доработать проведение', context: '📄 Модуль.bsl' },
  { role: 'step', text: '📖 Читаю a.bsl' },
  { role: 'step', text: '📖 Читаю b.bsl' },
  { role: 'assistant', text: 'Готово' },
  { role: 'error', text: 'Остановлено' },
];

test('запись разговора: роли, шаги одной строкой, прежний пересказ', () => {
  assert.equal(
    buildTranscript(entries),
    [
      '### Пересказ более ранней части разговора\nРанний пересказ',
      '### Я (приложено: 📄 Модуль.bsl)\nЦель: доработать проведение',
      '[Шаги: 📖 Читаю a.bsl; 📖 Читаю b.bsl]',
      '### Ты\nГотово',
      '[Ошибка: Остановлено]',
    ].join('\n\n'),
  );
});

test('длинная запись: первый вопрос и конец, середина пропущена, лимит соблюдён', () => {
  const long: ChatEntry[] = [{ role: 'user', text: 'ЦЕЛЬ' }];
  for (let i = 0; i < 100; i++) long.push({ role: 'assistant', text: `ответ ${i} ` + 'x'.repeat(1000) });
  const t = buildTranscript(long, 10_000);
  assert.ok(t.length <= 10_000, `длина ${t.length}`);
  assert.ok(t.startsWith('### Я\nЦЕЛЬ'));
  assert.match(t, /\[… пропущено сообщений: \d+ …\]/);
  assert.ok(t.includes('ответ 99 '));
  assert.ok(!t.includes('ответ 0 '));
});

test('мои сообщения для сверки: только вопросы пользователя, длинные обрезаны', () => {
  const list = userMessages([...entries, { role: 'user', text: 'x'.repeat(5000) }]);
  assert.deepEqual(list.slice(0, 1), ['Цель: доработать проведение']);
  assert.equal(list.length, 2);
  assert.ok(list[1].length < 2100 && list[1].endsWith(' […]'));
  assert.match(compactPrompt('', list), /<мои_сообщения>\nЦель: доработать проведение\n---\nx+ \[…\]\n<\/мои_сообщения>$/);
  assert.doesNotMatch(compactPrompt(''), /мои_сообщения/);
});

test('мои сообщения не помещаются — первые и последние, середина выброшена', () => {
  const many: ChatEntry[] = Array.from({ length: 50 }, (_, i) => ({ role: 'user', text: `вопрос ${i} ` + 'я'.repeat(990) }));
  const list = userMessages(many, 10_000);
  assert.ok(list.join('').length <= 10_000);
  assert.ok(list[0].startsWith('вопрос 0 '));
  assert.ok(list[list.length - 1].startsWith('вопрос 49 '));
});

test('после прежнего сжатия: запись и мои сообщения — с последнего пересказа', () => {
  const chat: ChatEntry[] = [
    { role: 'user', text: 'старый вопрос' },
    { role: 'assistant', text: 'старый ответ' },
    { role: 'compact', text: 'Пересказ: кодовое имя ОРИОН-7' },
    { role: 'user', text: 'новый вопрос' },
    { role: 'assistant', text: 'новый ответ' },
  ];
  assert.equal(buildTranscript(chat), '### Пересказ более ранней части разговора\nПересказ: кодовое имя ОРИОН-7\n\n### Я\nновый вопрос\n\n### Ты\nновый ответ');
  assert.deepEqual(userMessages(chat), ['новый вопрос']);
  // Прежний пересказ не выпадает при обрезке
  const long = [...chat, ...Array.from({ length: 50 }, (_, i): ChatEntry => ({ role: 'assistant', text: `ответ ${i} ` + 'x'.repeat(1000) }))];
  assert.ok(buildTranscript(long, 10_000).startsWith('### Пересказ более ранней части разговора\nПересказ: кодовое имя ОРИОН-7'));
});

test('огромный последний ответ — берётся его конец, лимит соблюдён', () => {
  const t = buildTranscript([{ role: 'user', text: 'цель' }, { role: 'assistant', text: 'н'.repeat(50_000) + 'КОНЕЦ' }], 10_000);
  assert.ok(t.length <= 10_000, `длина ${t.length}`);
  assert.ok(t.endsWith('КОНЕЦ'));
});

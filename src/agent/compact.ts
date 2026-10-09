/**
 * /compact — сжатие контекста: модель пересказывает разговор, пересказ уходит первым сообщением новой дискуссии.
 * Без зависимости от vscode — тестируется отдельно.
 *
 * Живой API (08.10.2026): при переполнении контекста (max_context_length ≈ 262 тыс. токенов) сервер не возвращает
 * ошибку, а молча выбрасывает старые сообщения — модель «не видит» начало чата. Поэтому сжимаем до отправки.
 */
import type { ChatEntry } from '../chatHistory';
import type { ContextUsage } from '../api/sseParser';

/** Подсказка «контекст почти заполнен» — после ответа, один раз до сжатия */
export const COMPACT_HINT_RATIO = 0.7;
/** Автосжатие — если контекст вместе с новым сообщением займёт больше этой доли (запас на ответ и результаты команд) */
export const AUTO_COMPACT_RATIO = 0.85;
// Символов на токен для прогноза размера сообщения — с запасом: код 1С ≈ 2,3, русский текст ≈ 3,8 (живой API)
const CHARS_PER_TOKEN = 2.3;
/** Запись разговора для пересказа в новой дискуссии — меньше предела одного сообщения (~300 тыс.) с запасом */
export const MAX_TRANSCRIPT_CHARS = 200_000;
const MAX_USER_MESSAGE_CHARS = 2_000;
const MAX_USER_MESSAGES_CHARS = 30_000;
/** Пересказ короче — модель, скорее всего, отказалась или ответила не тем */
const MIN_SUMMARY_CHARS = 150;

const SECTIONS = `Разделы (пустые пропускай):
1. **Цель** — чего я добиваюсь в этом чате.
2. **Мои сведения и указания** — пройди по каждому моему сообщению и выпиши отдельными пунктами: что я сообщил о задаче (названия, номера, имена — дословно), требования, запреты, предпочтения, мои исправления твоих ошибок. Служебные инструкции про @-команды и формат ответа сюда не относятся.
3. **Решения** — что решили и почему; отвергнутые варианты.
4. **Сделано** — созданные и изменённые файлы (путь и суть изменения), выполненные git-действия.
5. **Факты о проекте** — пути, имена объектов метаданных, процедур и переменных, найденные особенности; фрагменты кода — только короткие и только если без них не обойтись.
6. **Состояние** — на чём остановились, что осталось сделать, открытые вопросы.

Не пересказывай содержимое файлов — укажи путь, файл можно перечитать. Сохраняй конкретику: пути, имена, числа, тексты ошибок. Пиши кратко — обычно 2–6 тыс. символов.`;

/**
 * Инструкция модели: пересказать разговор в той же дискуссии — она помнит и прочитанные файлы.
 * userMessages — мои сообщения из истории чата: первое тонет в длинной инструкции по командам, и без перечня
 * модель теряла сказанное в нём, а в «Мои указания» записывала служебные инструкции (живой API: 3 из 4)
 */
export function compactPrompt(instructions = '', userMessages: string[] = []): string {
  return (
    'Контекст нашего чата скоро закончится. Составь пересказ всего разговора: дальше он заменит историю, и в новом чате ты будешь знать только его. ' +
    'Не используй команды (@read_file и другие) и инструменты — ответь только текстом пересказа, без вступления.\n\n' +
    SECTIONS +
    mustKeep(instructions) +
    (userMessages.length ? `\n\nДля сверки — все мои сообщения в этом чате по порядку:\n<мои_сообщения>\n${userMessages.join('\n---\n')}\n</мои_сообщения>` : '')
  );
}

/** Записи после последнего сжатия: более ранние уже в пересказе, и модель видит только его */
function sinceLastCompact(entries: ChatEntry[]): ChatEntry[] {
  const last = entries.map((e) => e.role).lastIndexOf('compact');
  return last === -1 ? entries : entries.slice(last);
}

/** Мои сообщения после последнего сжатия — для compactPrompt: длинные обрезаются, при переполнении — первые и последние */
export function userMessages(entries: ChatEntry[], maxChars = MAX_USER_MESSAGES_CHARS): string[] {
  const all = sinceLastCompact(entries)
    .filter((e) => e.role === 'user')
    .map((e) => (e.text.length > MAX_USER_MESSAGE_CHARS ? e.text.slice(0, MAX_USER_MESSAGE_CHARS) + ' […]' : e.text));
  let total = all.reduce((sum, t) => sum + t.length, 0);
  // Середину выбрасываем: в первых — цель и указания, в последних — текущее состояние
  while (total > maxChars && all.length > 2) {
    const [removed] = all.splice(Math.floor(all.length / 2), 1);
    total -= removed.length;
  }
  return all;
}

/** Инструкция для пересказа по записи разговора — когда дискуссия на сервере недоступна или переполнена */
export function compactTranscriptPrompt(transcript: string, instructions = ''): string {
  return (
    'Ниже — запись моего разговора с тобой (без содержимого прочитанных файлов и результатов команд). ' +
    'Составь его пересказ: дальше он заменит историю, и в новом чате ты будешь знать только его. ' +
    'Не используй команды и инструменты — ответь только текстом пересказа, без вступления.\n\n' +
    SECTIONS +
    mustKeep(instructions) +
    `\n\n<разговор>\n${transcript}\n</разговор>`
  );
}

function mustKeep(instructions: string): string {
  return instructions.trim() ? `\n\nОбязательно сохрани: ${instructions.trim()}` : '';
}

/** Пересказ в начале первого вопроса новой дискуссии */
export function summaryBlock(summary: string): string {
  return (
    'Это продолжение нашего прежнего разговора: его история сжата в пересказ ниже. Считай пересказ тем, что ты уже знаешь; ' +
    'если понадобится содержимое файлов — перечитай их.\n\n' +
    `<пересказ>\n${summary.trim()}\n</пересказ>`
  );
}

/** Пересказ годится: не пустой и не отказ сервера */
export function isUsableSummary(text: string): boolean {
  const t = text.trim();
  return t.length >= MIN_SUMMARY_CHARS && !/^Не удалось сформировать ответ/i.test(t);
}

export function contextPercent(usage: ContextUsage): number {
  return Math.round((usage.tokens / usage.limit) * 100);
}

/** Сжать перед отправкой: контекст вместе с новым сообщением займёт больше AUTO_COMPACT_RATIO */
export function needsAutoCompact(usage: ContextUsage | undefined, messageChars: number): boolean {
  if (!usage) return false;
  return usage.tokens + messageChars / CHARS_PER_TOKEN > usage.limit * AUTO_COMPACT_RATIO;
}

/**
 * Запись разговора для пересказа: с последнего пересказа (всё раньше уже в нём) — вопросы, ответы, шаги работы с проектом.
 * Не помещается — первый блок (прежний пересказ или первый вопрос с целью) и самый конец, середина пропускается
 */
export function buildTranscript(entries: ChatEntry[], maxChars = MAX_TRANSCRIPT_CHARS): string {
  const blocks: string[] = [];
  let steps: string[] = [];
  const flushSteps = () => {
    if (steps.length) blocks.push(`[Шаги: ${steps.join('; ')}]`);
    steps = [];
  };
  for (const e of sinceLastCompact(entries)) {
    if (e.role === 'step') {
      steps.push(e.text);
      continue;
    }
    flushSteps();
    if (e.role === 'user') blocks.push(`### Я${e.context ? ` (приложено: ${e.context})` : ''}\n${e.text}`);
    else if (e.role === 'assistant') blocks.push(`### Ты\n${e.text}`);
    else if (e.role === 'compact') blocks.push(`### Пересказ более ранней части разговора\n${e.text}`);
    else blocks.push(`[Ошибка: ${e.text}]`);
  }
  flushSteps();

  const full = blocks.join('\n\n');
  if (full.length <= maxChars) return full;
  const head = blocks[0].slice(0, maxChars / 4);
  // Запас на отметку о пропуске и разделители
  let budget = maxChars - head.length - 100;
  const tail: string[] = [];
  for (let i = blocks.length - 1; i > 0 && budget > 0; i--) {
    // Последний блок может не поместиться целиком — берём его конец
    const b = blocks[i].length > budget ? '…' + blocks[i].slice(-(budget - 1)) : blocks[i];
    tail.unshift(b);
    budget -= b.length + 2;
  }
  const skipped = blocks.length - 1 - tail.length;
  return [head, ...(skipped > 0 ? [`[… пропущено сообщений: ${skipped} …]`] : []), ...tail].join('\n\n');
}

/**
 * Сценарии без VS Code: тот же NaparnikClient, что в расширении, против живого API через прокси набора.
 * Группы: api — обычные ответы и ошибки API; faults — сбои сети и сервера, которые подставляет прокси.
 */
import { ApiError, NaparnikClient } from '../api/client';
import { Scenario, check } from './common';

const LONG_QUESTION = 'Перечисли 8 примитивных и ссылочных типов данных платформы 1С:Предприятие 8.3, по одному предложению о каждом.';

function client(baseUrl: string, over: Partial<{ token: string; authFormat: 'plain' | 'bearer'; skillName: string; timeoutMs: number }> = {}): NaparnikClient {
  return new NaparnikClient({
    token: over.token ?? process.env.NAPARNIK_API_TOKEN!,
    baseUrl,
    authFormat: over.authFormat ?? 'plain',
    skillName: over.skillName ?? 'custom',
    timeoutMs: over.timeoutMs ?? 300_000,
  });
}

/** Вопрос с замером времени до первого символа; text — итог, partial — последний показанный текст */
async function ask(
  c: NaparnikClient,
  question: string,
  opts: { conversationId?: string; parent?: string; signal?: AbortSignal; onFirstText?: () => void } = {},
): Promise<{ text: string; uuid?: string; ttfcMs?: number; conversationId: string; partial: string; textEvents: number }> {
  const conversationId = opts.conversationId ?? (await c.createConversation(opts.signal));
  const start = Date.now();
  let ttfcMs: number | undefined;
  let partial = '';
  let textEvents = 0;
  const answer = await c.sendMessage(
    conversationId,
    question,
    opts.parent,
    {
      onText: (t) => {
        textEvents++;
        partial = t;
        if (t && ttfcMs === undefined) {
          ttfcMs = Date.now() - start;
          opts.onFirstText?.();
        }
      },
    },
    opts.signal,
  );
  return { text: answer.text, uuid: answer.assistantUuid, ttfcMs, conversationId, partial, textEvents };
}

const noBrokenChars = (text: string) => check(!text.includes('�'), 'в ответе битые символы U+FFFD');
const hasCyrillic = (text: string) => check(/[а-яё]/i.test(text), 'в ответе нет кириллицы');

/** Ошибка, которую должен выдать запрос; возвращает её и время до неё */
async function expectError(fn: () => Promise<unknown>): Promise<{ err: unknown; ms: number }> {
  const start = Date.now();
  try {
    await fn();
  } catch (err) {
    return { err, ms: Date.now() - start };
  }
  throw new Error('ожидалась ошибка, а запрос завершился успешно');
}

export function apiScenarios(base: string): Scenario[] {
  return [
    {
      name: 'custom: короткий вопрос по 1С',
      kind: 'positive',
      run: async () => {
        const r = await ask(client(base), 'Что возвращает функция СтрНайти в 1С? Ответь одним предложением.');
        hasCyrillic(r.text);
        noBrokenChars(r.text);
        return { ttfcMs: r.ttfcMs, details: `${r.text.length} симв., событий текста ${r.textEvents}` };
      },
    },
    {
      name: 'raw: короткий вопрос по 1С',
      kind: 'positive',
      run: async () => {
        const r = await ask(client(base, { skillName: 'raw' }), 'Как в 1С объявить экспортную процедуру? Ответь одной строкой кода.');
        check(r.text.length > 0, 'пустой ответ');
        return { ttfcMs: r.ttfcMs, details: `${r.text.length} симв.` };
      },
    },
    {
      name: 'custom: длинный ответ, стрим собирается целиком',
      kind: 'positive',
      run: async () => {
        const r = await ask(client(base), LONG_QUESTION);
        hasCyrillic(r.text);
        noBrokenChars(r.text);
        check(r.partial.trim().length > 0 && r.text.startsWith(r.partial.trim().slice(0, 20)), 'показанный текст не совпадает с итогом');
        return { ttfcMs: r.ttfcMs, details: `${r.text.length} симв., событий текста ${r.textEvents}` };
      },
    },
    {
      name: 'авторизация bearer',
      kind: 'positive',
      run: async () => {
        try {
          const r = await ask(client(base, { authFormat: 'bearer' }), 'Ответь одним словом: да.');
          return { ttfcMs: r.ttfcMs, details: 'bearer принят' };
        } catch (err) {
          // Сервис может не принимать Bearer — тогда сообщение должно быть понятным, а не падением
          check(err instanceof ApiError && [401, 403].includes(err.status) && /Токен не принят/.test(err.message), `bearer: непонятная ошибка ${String(err)}`);
          return { details: `bearer не принят сервисом: ${err.message}` };
        }
      },
    },
    {
      name: 'многошаговый диалог сохраняет контекст',
      kind: 'positive',
      run: async () => {
        const c = client(base);
        const first = await ask(c, 'Моя переменная называется ФиалкаСемь. Ответь только «ок».');
        const second = await ask(c, 'Как называется моя переменная из предыдущего сообщения? Ответь только именем.', { conversationId: first.conversationId, parent: first.uuid });
        check(/ФиалкаСемь/i.test(second.text), `модель не вспомнила: «${second.text.slice(0, 80)}»`);
        return { ttfcMs: second.ttfcMs };
      },
    },
    {
      name: 'неверный токен — понятная ошибка без повторов',
      kind: 'negative',
      run: async () => {
        const { err } = await expectError(() => client(base, { token: 'naparnik-live-test-invalid-token-000' }).createConversation());
        check(err instanceof ApiError && [401, 403].includes(err.status), `ожидался 401/403, получено: ${String(err)}`);
        check(/Задать токен/.test(err.message), 'нет подсказки задать токен');
        return { details: err.message };
      },
    },
    {
      name: 'пустой токен — ошибка до запроса',
      kind: 'negative',
      run: async () => {
        const { err } = await expectError(async () => client(base, { token: '' }));
        check(err instanceof Error && /Токен пустой/.test(err.message), `ожидалась ошибка пустого токена: ${String(err)}`);
      },
    },
    {
      name: 'два чата одновременно не смешивают ответы',
      kind: 'negative',
      run: async () => {
        const c = client(base);
        const [a, b] = await Promise.all([
          ask(c, 'Ответь только словом ЯБЛОКО заглавными буквами.'),
          ask(c, 'Ответь только словом ГРУША заглавными буквами.'),
        ]);
        check(/ЯБЛОКО/.test(a.text) && !/ГРУША/.test(a.text), `чат 1: «${a.text.slice(0, 60)}»`);
        check(/ГРУША/.test(b.text) && !/ЯБЛОКО/.test(b.text), `чат 2: «${b.text.slice(0, 60)}»`);
        check(a.conversationId !== b.conversationId, 'одна дискуссия на два чата');
        return { ttfcMs: Math.max(a.ttfcMs ?? 0, b.ttfcMs ?? 0) };
      },
    },
    {
      name: 'отмена до ответа',
      kind: 'negative',
      run: async () => {
        const c = client(base);
        const conversationId = await c.createConversation();
        const abort = new AbortController();
        setTimeout(() => abort.abort(), 300);
        const { err, ms } = await expectError(() => ask(c, LONG_QUESTION, { conversationId, signal: abort.signal }));
        check(abort.signal.aborted && ms < 3_000, `отмена не сработала быстро: ${ms} мс, ${String(err)}`);
        return { details: `остановлено через ${ms} мс` };
      },
    },
    {
      name: 'отмена во время стрима',
      kind: 'negative',
      run: async () => {
        const c = client(base);
        const abort = new AbortController();
        let abortedAt = 0;
        const { ms } = await expectError(() =>
          ask(c, LONG_QUESTION, {
            signal: abort.signal,
            onFirstText: () => {
              abortedAt = Date.now();
              abort.abort();
            },
          }),
        );
        const lag = Date.now() - abortedAt;
        check(abortedAt > 0, 'текст так и не пришёл');
        check(lag < 2_000, `после отмены поток читался ещё ${lag} мс`);
        return { details: `остановлено через ${lag} мс после первого символа (всего ${ms} мс)` };
      },
    },
  ];
}

export function faultScenarios(base: string, faultUrl: (id: string, spec: string) => string): Scenario[] {
  const retryOk = (name: string, spec: string, minMs = 0): Scenario => ({
    name,
    kind: 'negative',
    run: async () => {
      const start = Date.now();
      const r = await ask(client(faultUrl(name, spec)), 'Ответь одним словом: готово.');
      const ms = Date.now() - start;
      check(r.text.length > 0, 'пустой ответ после повтора');
      check(ms >= minMs, `повтор раньше Retry-After: ${ms} мс`);
      return { ttfcMs: r.ttfcMs, details: `успех после повтора за ${ms} мс` };
    },
  });
  return [
    retryOk('429 с Retry-After: 2 — повтор после паузы', 's429ra2x1', 2_000),
    retryOk('429 без Retry-After — повтор с задержкой', 's429x1'),
    retryOk('500 — повтор', 's500x1'),
    retryOk('502 — повтор', 's502x1'),
    retryOk('503 — повтор', 's503x1'),
    retryOk('сброс соединения до ответа — повтор', 'resetx1'),
    {
      name: '503 постоянно — ограниченные повторы и понятная ошибка',
      kind: 'negative',
      run: async () => {
        const c = client(base);
        const conversationId = await c.createConversation();
        const faulty = client(faultUrl('503inf', 's503xinf'));
        const { err, ms } = await expectError(() => ask(faulty, 'тест', { conversationId }));
        check(err instanceof ApiError && err.status === 503, `ожидался 503: ${String(err)}`);
        check(ms < 30_000, `повторы заняли ${ms} мс`);
        return { details: `${err.message.slice(0, 80)} за ${ms} мс` };
      },
    },
    {
      name: 'обрыв соединения посреди стрима — ошибка, частичный текст виден',
      kind: 'negative',
      run: async () => {
        let partial = '';
        const c = client(faultUrl('cut', 'cut6'));
        const { err } = await expectError(async () => {
          const conversationId = await c.createConversation();
          await c.sendMessage(conversationId, LONG_QUESTION, undefined, { onText: (t) => (partial = t) });
        });
        check(err instanceof Error, 'не ошибка');
        return { details: `ошибка «${(err as Error).message.slice(0, 60)}», частичный текст ${partial.length} симв.` };
      },
    },
    {
      name: 'поток закрыт без finished — не выдаётся за полный ответ',
      kind: 'negative',
      run: async () => {
        let partial = '';
        const c = client(faultUrl('end', 'end6'));
        const conversationId = await c.createConversation();
        const { err } = await expectError(() => c.sendMessage(conversationId, LONG_QUESTION, undefined, { onText: (t) => (partial = t) }));
        check(err instanceof Error && /оборвал/i.test(err.message), `непонятная ошибка: ${String(err)}`);
        return { details: `частичный текст ${partial.length} симв.` };
      },
    },
    {
      name: 'пауза в данных дольше timeoutSeconds — таймаут',
      kind: 'negative',
      run: async () => {
        const c = client(faultUrl('stall', 'stall9000'), { timeoutMs: 4_000 });
        const conversationId = await c.createConversation();
        const { err, ms } = await expectError(() => c.sendMessage(conversationId, LONG_QUESTION, undefined, { onText: () => undefined }));
        check(err instanceof Error && err.name === 'TimeoutError', `ожидался TimeoutError: ${String(err)}`);
        check(ms < 15_000, `таймаут через ${ms} мс`);
        return { details: `таймаут через ${ms} мс` };
      },
    },
    {
      name: 'только heartbeat дольше timeoutSeconds — таймаут',
      kind: 'negative',
      run: async () => {
        const c = client(faultUrl('hb', 'hb9000'), { timeoutMs: 4_000 });
        const conversationId = await c.createConversation();
        const { err, ms } = await expectError(() => c.sendMessage(conversationId, LONG_QUESTION, undefined, { onText: () => undefined }));
        check(err instanceof Error && err.name === 'TimeoutError', `ожидался TimeoutError: ${String(err)}`);
        return { details: `таймаут через ${ms} мс` };
      },
    },
    {
      name: 'кусок разрезан посреди символа UTF-8 — кириллица целая',
      kind: 'negative',
      run: async () => {
        const r = await ask(client(faultUrl('split', 'split')), 'Напиши одно предложение про справочник «Номенклатура» в 1С.');
        hasCyrillic(r.text);
        noBrokenChars(r.text);
        noBrokenChars(r.partial);
        return { ttfcMs: r.ttfcMs, details: `${r.text.length} симв.` };
      },
    },
  ];
}

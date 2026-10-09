/**
 * HTTP-клиент к API 1С:Напарник (code.1c.ai).
 * Порт OneCApiClient из 1c-ai-mcp, адаптированный под чат: ответ стримится в UI.
 */
import { ContextUsage, SseParser, SseParseResult, ToolCall, stripThinkingTags } from './sseParser';

export interface ClientConfig {
  token: string;
  baseUrl: string;
  authFormat: 'plain' | 'bearer';
  skillName: string;
  timeoutMs: number;
}

export interface StreamCallbacks {
  /** Текущий видимый текст ответа целиком (не дельта) — UI просто перерисовывает */
  onText: (text: string) => void;
  /** Модель вызвала серверные инструменты (поиск по ИТС, документации) */
  onToolCalls?: (toolNames: string[]) => void;
  /** Пояснение для модели, когда она вызывает недоступный инструмент (например, инструменты 1С:EDT) */
  unavailableToolHint?: string;
  /** Модель вызвала инструменты, которые мы отклонили (инструменты 1С:EDT) */
  onRejectedTools?: (toolNames: string[]) => void;
  /**
   * Выполнить недоступный инструмент своими силами (ReadSystemFile → чтение файла проекта).
   * Возвращает текст для модели или undefined — тогда вызов отклоняется с unavailableToolHint
   */
  emulateTool?: (call: ToolCall) => Promise<string | undefined>;
  /**
   * Просьба продолжить: ответ пришёл пустым или модель зациклилась на бесполезных инструментах
   * (план TodoWrite, отклонённые инструменты 1С:EDT). В агентном режиме — продолжить @-командами
   */
  continueHint?: string;
}

// Инструменты сервиса, которые работают без 1С:EDT. Остальные (WriteSystemFile, GetObject_in_Project…)
// требуют сессии EDT и без неё падают — такие вызовы отклоняем
const USABLE_SERVER_TOOLS = ['mcp__knowledge-hub__', 'mcp__syntax-checker__', 'mcp__web__'];
// План задач модели: сервер выполняет его сам, без 1С:EDT (проверено). Отклонять его — лишние запросы,
// а модель вызывает его часто: 10 отказов подряд упирались в лимит раундов
const USABLE_SERVER_TOOL_NAMES = new Set(['TodoWrite']);

export function isUsableServerTool(name: string | undefined): boolean {
  return Boolean(name && (USABLE_SERVER_TOOL_NAMES.has(name) || USABLE_SERVER_TOOLS.some((prefix) => name.startsWith(prefix))));
}

const DEFAULT_UNAVAILABLE_HINT = 'Инструмент недоступен: работа идёт не из 1С:EDT, сессии проекта нет. Ответь без него.';
const DEFAULT_CONTINUE_HINT = 'Не вызывай больше инструменты — ответь, пожалуйста, на мой предыдущий вопрос текстом.';

export interface ChatAnswer {
  text: string;
  /** UUID ответа ассистента — передаётся как parentUuid следующего сообщения, чтобы модель помнила контекст */
  assistantUuid?: string;
  /** Заполненность контекста после ответа — для индикатора и автоматического сжатия */
  usage?: ContextUsage;
}

// Жёсткий предел на случай, если зацикливание не распознано; обычно хватает 1–8 раундов поиска
const MAX_TOOL_ROUNDS = 25;
// Столько раундов подряд без пользы (только TodoWrite или отклонённые вызовы) — модель зациклилась.
// Наблюдалось на живом API: TodoWrite 11 раз подряд (сервер отвечает «continue to use the todo list»),
// Task — 10 отказов подряд. Тогда вместо ответа инструменту пишем от пользователя «продолжай»
const MAX_IDLE_TOOL_ROUNDS = 3;
const MAX_CONTINUE_REQUESTS = 2;

// package.json лежит на два уровня выше out/api/ — и в .vsix, и при запуске тестов
// eslint-disable-next-line @typescript-eslint/no-var-requires
const USER_AGENT = `naparnik-1c-vscode/${require('../../package.json').version} (unofficial)`;

/**
 * Проверить формат токена. Возвращает текст проблемы или undefined, если токен годится.
 * Заголовки HTTP допускают только ASCII: кириллица (русская раскладка) или пробел внутри
 * токена иначе дают невнятную ошибку fetch «Cannot convert argument to a ByteString».
 */
export function findTokenProblem(token: string): string | undefined {
  if (!token) {
    return 'Токен пустой.';
  }
  const bad = [...token].findIndex((ch) => !/[\x21-\x7E]/.test(ch));
  if (bad === -1) {
    return undefined;
  }
  const ch = [...token][bad];
  const what = /\s/.test(ch) ? 'пробел или перенос строки' : `символ «${ch}»`;
  const hint = /[а-яё]/i.test(ch) ? ' Похоже, токен набран в русской раскладке.' : '';
  return `Токен содержит недопустимый ${what} (позиция ${bad + 1}).${hint} Скопируйте токен заново из личного кабинета code.1c.ai.`;
}

export class NaparnikClient {
  constructor(private readonly config: ClientConfig) {
    const problem = findTokenProblem(config.token);
    if (problem) {
      throw new Error(`${problem} Задайте его командой «1С:Напарник: Задать токен».`);
    }
  }

  private get baseUrl(): string {
    return this.config.baseUrl.replace(/\/+$/, '');
  }

  private headers(accept: string): Record<string, string> {
    const { token, authFormat } = this.config;
    return {
      Accept: accept,
      'Accept-Language': 'ru-ru,en-us;q=0.8,en;q=0.7',
      Authorization: authFormat === 'bearer' ? `Bearer ${token}` : token,
      'Content-Type': 'application/json; charset=utf-8',
      // Честно представляемся сторонним клиентом, не маскируясь под официальный веб-чат
      'User-Agent': USER_AGENT,
    };
  }

  /** Создать дискуссию, вернуть её UUID */
  async createConversation(signal?: AbortSignal): Promise<string> {
    const response = await fetch(`${this.baseUrl}/chat_api/v1/conversations/`, {
      method: 'POST',
      headers: { ...this.headers('*/*'), 'Session-Id': '' },
      body: JSON.stringify({
        tool_name: 'custom',
        skill_name: this.config.skillName,
        ui_language: 'russian',
        script_language: 'ru',
        is_chat: true,
      }),
      signal: this.withTimeout(signal),
    });

    if (!response.ok) {
      throw new ApiError(response.status, await safeText(response));
    }
    const data = (await response.json()) as { uuid?: string };
    if (!data.uuid) {
      throw new Error('API не вернул UUID дискуссии');
    }
    return data.uuid;
  }

  /**
   * Отправить сообщение и дождаться итогового ответа.
   * Если модель запрашивает серверные инструменты — подтверждаем их (status=accepted),
   * сервер сам выполняет поиск и продолжает генерацию.
   * parentUuid — UUID предыдущего ответа ассистента; без него модель не видит историю.
   */
  async sendMessage(
    conversationId: string,
    message: string,
    parentUuid: string | undefined,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<ChatAnswer> {
    // content — объект, НЕ массив: иначе API отвечает 422
    let payload: object = {
      parent_uuid: parentUuid ?? null,
      role: 'user',
      content: { content: { instruction: message } },
    };
    let continueRequests = 0;
    let idleRounds = 0;
    // Отправлен ответ на tool_calls — сервер выполняет инструменты
    let toolsAcked = false;
    const seenCalls = new Set<string>();
    // Последний ответ ассистента в этом обмене — от него можно продолжить, не теряя вопрос пользователя
    let lastAssistantUuid: string | undefined;
    const hint = callbacks.continueHint ?? DEFAULT_CONTINUE_HINT;
    // Сначала просим продолжить в той же ветке: сервер принимает сообщение пользователя и в ответ на неотвеченные
    // tool_calls, контекст сохраняется (проверено). Не помогло — задаём вопрос заново от прежнего ответа:
    // зацикленная ветка («continue to use the todo list» по кругу) выпадает из контекста модели
    const askToContinue = (parent: string | undefined): boolean => {
      if (continueRequests >= MAX_CONTINUE_REQUESTS || (continueRequests === 0 && !parent)) return false;
      payload =
        continueRequests === 0
          ? { parent_uuid: parent, role: 'user', content: { content: { instruction: hint } } }
          : { parent_uuid: parentUuid ?? null, role: 'user', content: { content: { instruction: `${message}\n\n${hint}` } } };
      continueRequests++;
      idleRounds = 0;
      toolsAcked = false;
      return true;
    };

    for (let round = 0; round <= MAX_TOOL_ROUNDS + MAX_CONTINUE_REQUESTS; round++) {
      let result: SseParseResult;
      try {
        result = await this.streamRequest(conversationId, payload, callbacks, signal);
      } catch (err) {
        // Сервер изредка сам закрывает вызов инструмента (наблюдалось с WriteSystemFile) и отвергает наш ответ на него
        // («No tool calls found in the previous assistant message») — просим продолжить от того же ответа
        if (err instanceof ApiError && err.status === 422 && err.message.includes('No tool calls found') && askToContinue(lastAssistantUuid)) continue;
        // Сервер завис, выполняя инструмент (живой API: TodoWrite после отклонённых ReadResource), — просим продолжить
        // от последнего ответа. Остановку пользователем и зависание обычного ответа не трогаем
        const timedOut = err instanceof Error && err.name === 'TimeoutError' && !signal?.aborted;
        if (timedOut && toolsAcked && askToContinue(lastAssistantUuid)) continue;
        throw err;
      }
      // Вызовы без id сервер создаёт, когда принимает текст модели за вызов инструмента
      // (например, XML-теги в ответе). Подтвердить их нельзя — считаем ответ обычным текстом.
      const accepted = result.toolCalls.filter((tc) => tc.id);

      if (!result.hasToolCalls || accepted.length === 0) {
        if (result.hasOnlyReasoning) {
          throw new Error('API вернул только рассуждения без итогового ответа');
        }
        const text = stripThinkingTags(result.text);
        if (text) {
          return { text, assistantUuid: result.assistantUuid, ...(result.usage && { usage: result.usage }) };
        }
        // Сервер изредка присылает пустой ответ (наблюдалось после отклонённых инструментов 1С:EDT).
        // Просим продолжить, а не роняем весь запрос
        if (askToContinue(result.assistantUuid ?? lastAssistantUuid)) continue;
        throw new Error('API не вернул текстовый ответ');
      }

      if (!result.assistantUuid) {
        throw new Error('API вернул tool_calls без идентификатора сообщения');
      }
      lastAssistantUuid = result.assistantUuid;
      const usable = accepted.filter((tc) => isUsableServerTool(tc.function?.name));
      if (usable.length > 0) {
        callbacks.onToolCalls?.(usable.map(toolName));
      }
      // Недоступные инструменты: часть выполняем сами (ответ — их результат), остальные отклоняем
      const emulated = new Map<ToolCall, string>();
      const rejected: ToolCall[] = [];
      for (const tc of accepted.filter((c) => !isUsableServerTool(c.function?.name))) {
        const reply = await callbacks.emulateTool?.(tc);
        if (reply === undefined) rejected.push(tc);
        else emulated.set(tc, reply);
      }
      if (rejected.length > 0) {
        callbacks.onRejectedTools?.(rejected.map(toolName));
      }

      // Полезен новый вызов поиска или выполненного нами инструмента; план и повтор того же вызова — нет
      // (наблюдалось: TodoWrite и чтение тех же двух файлов по кругу)
      let useful = false;
      for (const tc of [...usable, ...emulated.keys()]) {
        const key = `${tc.function?.name}\n${tc.function?.arguments ?? ''}`;
        if (USABLE_SERVER_TOOL_NAMES.has(tc.function?.name ?? '') || seenCalls.has(key)) continue;
        seenCalls.add(key);
        useful = true;
      }
      idleRounds = useful ? 0 : idleRounds + 1;
      // Зациклилась или исчерпала раунды — просим продолжить без инструментов
      if ((idleRounds >= MAX_IDLE_TOOL_ROUNDS || round >= MAX_TOOL_ROUNDS - 1) && askToContinue(result.assistantUuid)) {
        continue;
      }

      toolsAcked = true;
      payload = {
        parent_uuid: result.assistantUuid,
        role: 'tool',
        // accepted — сервер выполнит сам (content обязан быть пустым); rejected — с нашим результатом или пояснением
        content: accepted.map((tc) =>
          emulated.has(tc)
            ? { tool_call_id: tc.id, status: 'rejected', content: emulated.get(tc) }
            : rejected.includes(tc)
              ? { tool_call_id: tc.id, status: 'rejected', content: callbacks.unavailableToolHint ?? DEFAULT_UNAVAILABLE_HINT }
              : { tool_call_id: tc.id, status: 'accepted', content: null },
        ),
      };
    }
    throw new Error('Превышен лимит шагов поиска 1С:Напарник');
  }

  private async streamRequest(
    conversationId: string,
    payload: object,
    callbacks: StreamCallbacks,
    signal?: AbortSignal,
  ): Promise<SseParseResult> {
    // Таймаут — на паузу в данных, а не на весь ответ: длинный, но идущий ответ не обрываем
    const idle = new IdleTimeout(this.config.timeoutMs);
    try {
      const response = await fetch(`${this.baseUrl}/chat_api/v1/conversations/${conversationId}/messages`, {
        method: 'POST',
        headers: this.headers('text/event-stream'),
        body: JSON.stringify(payload),
        signal: signal ? AbortSignal.any([signal, idle.signal]) : idle.signal,
      });
      if (!response.ok || !response.body) {
        throw new ApiError(response.status, await safeText(response));
      }
      return await this.readStream(response.body, callbacks, idle);
    } finally {
      idle.dispose();
    }
  }

  private async readStream(body: ReadableStream<Uint8Array>, callbacks: StreamCallbacks, idle: IdleTimeout): Promise<SseParseResult> {
    const parser = new SseParser();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // Читаем поток кусками и режем на строки: кусок может оборваться посреди строки
    for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        // Таймер продлевают только события: «: heartbeat» сервер шлёт и тогда, когда сам завис
        // (живой API: /init висел 26+ минут после TodoWrite — таймаут не срабатывал)
        if (line.startsWith('data: ')) idle.reset();
        parser.feedLine(line.replace(/\r$/, ''));
      }
      callbacks.onText(parser.visibleText);
    }
    // Поток читаем до конца: после завершённого ответа сервер может продолжить следующим
    if (buffer) {
      parser.feedLine(buffer);
    }
    return parser.result();
  }

  /** Объединить пользовательскую отмену с таймаутом запроса */
  private withTimeout(signal?: AbortSignal): AbortSignal {
    const timeout = AbortSignal.timeout(this.config.timeoutMs);
    return signal ? AbortSignal.any([signal, timeout]) : timeout;
  }
}

/** Таймер бездействия: срабатывает, если данных не было дольше ms; reset() — пришли данные */
class IdleTimeout {
  private readonly controller = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly ms: number) {
    this.reset();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  reset(): void {
    clearTimeout(this.timer);
    // Ошибка с именем TimeoutError — как у AbortSignal.timeout, её распознаёт чат
    this.timer = setTimeout(() => this.controller.abort(new DOMException('Нет данных от сервера', 'TimeoutError')), this.ms);
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    body: string,
  ) {
    super(describeStatus(status, body));
  }
}

function describeStatus(status: number, body: string): string {
  if (status === 401 || status === 403) {
    return `Токен не принят (HTTP ${status}). Проверьте токен командой «1С:Напарник: Задать токен».`;
  }
  if (status === 429) {
    // Лимит считается на все чаты сразу: несколько ответов параллельно быстро его исчерпывают
    return 'Сервис 1С:Напарник ограничил частоту сообщений (HTTP 429). Повторите позже. Лимит общий для всех чатов — параллельные ответы расходуют его быстрее.';
  }
  return `Ошибка API (HTTP ${status}): ${body.slice(0, 300)}`;
}

function toolName(tc: ToolCall): string {
  return tc.function?.name ?? 'инструмент';
}

async function safeText(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

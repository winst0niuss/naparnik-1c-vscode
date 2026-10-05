/**
 * HTTP-клиент к API 1С:Напарник (code.1c.ai).
 * Порт OneCApiClient из 1c-ai-mcp, адаптированный под чат: ответ стримится в UI.
 */
import { SseParser, SseParseResult, ToolCall, stripThinkingTags, unwrapToolResult } from './sseParser';

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
}

export interface ChatAnswer {
  text: string;
  /** UUID ответа ассистента — передаётся как parentUuid следующего сообщения, чтобы модель помнила контекст */
  assistantUuid?: string;
}

const MAX_TOOL_ROUNDS = 10;

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
    let hadToolCalls = false;

    for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
      const result = await this.streamRequest(conversationId, payload, callbacks, signal);

      if (!result.hasToolCalls) {
        if (result.hasOnlyReasoning) {
          throw new Error('API вернул только рассуждения без итогового ответа');
        }
        let text = stripThinkingTags(result.text);
        if (hadToolCalls) {
          text = unwrapToolResult(text);
        }
        if (!text) {
          throw new Error('API не вернул текстовый ответ');
        }
        return { text, assistantUuid: result.assistantUuid };
      }

      hadToolCalls = true;
      if (!result.assistantUuid) {
        throw new Error('API вернул tool_calls без идентификатора сообщения');
      }
      const accepted = result.toolCalls.filter((tc) => tc.id);
      if (accepted.length === 0) {
        throw new Error('API вернул tool_calls без идентификаторов вызовов');
      }
      callbacks.onToolCalls?.(accepted.map(toolName));

      payload = {
        parent_uuid: result.assistantUuid,
        role: 'tool',
        content: accepted.map((tc) => ({ tool_call_id: tc.id, status: 'accepted', content: null })),
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
    const response = await fetch(`${this.baseUrl}/chat_api/v1/conversations/${conversationId}/messages`, {
      method: 'POST',
      headers: this.headers('text/event-stream'),
      body: JSON.stringify(payload),
      signal: this.withTimeout(signal),
    });
    if (!response.ok || !response.body) {
      throw new ApiError(response.status, await safeText(response));
    }

    const parser = new SseParser();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    // Читаем поток кусками и режем на строки: кусок может оборваться посреди строки
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        parser.feedLine(line.replace(/\r$/, ''));
      }
      callbacks.onText(parser.visibleText);
      if (parser.done) {
        break;
      }
    }
    if (!parser.done && buffer) {
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

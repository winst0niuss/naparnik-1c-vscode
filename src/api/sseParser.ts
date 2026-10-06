/**
 * Парсер SSE-ответа API 1С:Напарник: каждую строку можно скормить по мере прихода.
 * Формат событий сверен с живым API: { uuid, role, content, content_delta, finished }.
 */

export interface ToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

export interface SseParseResult {
  text: string;
  hasToolCalls: boolean;
  hasOnlyReasoning: boolean;
  toolCalls: ToolCall[];
  assistantUuid?: string;
}

// Любой JSON-объект из SSE: без строгой схемы, поля бывают null
type Json = Record<string, any>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class SseParser {
  private deltaText = '';
  private finalText = '';
  private hasReasoning = false;
  private hasToolCalls = false;
  private toolCalls: ToolCall[] | undefined;
  private assistantUuid: string | undefined;
  // Ответ ассистента завершён (finished), но поток может продолжиться следующим ответом
  private messageFinished = false;

  /** Обработать одну строку SSE-потока */
  feedLine(line: string): void {
    if (!line.startsWith('data: ')) {
      return; // «: heartbeat …» и прочие служебные строки
    }
    let data: unknown;
    try {
      data = JSON.parse(line.slice(6));
    } catch {
      return;
    }
    // Echo вопроса пользователя и результат инструмента (после ACK он идёт перед ответом ассистента) пропускаем
    if (!isObject(data) || data.role === 'user' || data.role === 'tool') {
      return;
    }

    // В одном потоке бывает несколько ответов: сервер сам отклоняет вызов несуществующего инструмента
    // («'Search_ITS' is unknown tool») и продолжает генерацию. Итог — последний ответ
    if (this.messageFinished) {
      this.reset();
    }
    if (data.role === 'assistant' && data.uuid) {
      this.assistantUuid = data.uuid;
    }

    // Дельта: строка или объект { content, tool_calls, reasoning_content }
    const delta = data.content_delta;
    if (typeof delta === 'string') {
      this.deltaText += delta;
    } else if (isObject(delta)) {
      this.readPart(delta, false);
    }
    // Итоговое событие: content.content (или content.text) — полный текст, перекрывает дельты
    if (isObject(data.content)) {
      this.readPart(data.content, true);
    }

    if (data.finished) {
      this.messageFinished = true;
    }
  }

  private readPart(part: Json, final: boolean): void {
    const text = final ? part.text || part.content : part.content;
    if (typeof text === 'string') {
      if (final && text) this.finalText = text;
      else if (!final) this.deltaText += text;
    }
    if (Array.isArray(part.tool_calls) && part.tool_calls.length > 0) {
      this.hasToolCalls = true;
      this.toolCalls = part.tool_calls;
    }
    if (part.reasoning_content) {
      this.hasReasoning = true;
    }
  }

  private reset(): void {
    this.deltaText = '';
    this.finalText = '';
    this.hasReasoning = false;
    this.hasToolCalls = false;
    this.toolCalls = undefined;
    this.assistantUuid = undefined;
    this.messageFinished = false;
  }

  /** Текст, который можно показывать пользователю прямо сейчас (без thinking-блоков) */
  get visibleText(): string {
    return stripThinkingTags(this.finalText || this.deltaText, true);
  }

  result(): SseParseResult {
    const text = (this.finalText || this.deltaText).trim();
    return {
      text,
      hasToolCalls: this.hasToolCalls,
      hasOnlyReasoning: this.hasReasoning && !text,
      toolCalls: this.toolCalls ?? [],
      assistantUuid: this.assistantUuid,
    };
  }
}

/**
 * Удалить <thinking>/<think> блоки.
 * streaming=true — дополнительно скрыть незакрытый блок в конце (он ещё генерируется).
 */
export function stripThinkingTags(text: string, streaming = false): string {
  let result = text.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/g, '');
  if (streaming) {
    result = result.replace(/<think(?:ing)?>[\s\S]*$/, '');
  }
  return result.trim();
}

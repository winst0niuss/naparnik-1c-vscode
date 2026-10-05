/**
 * Парсер SSE-ответа API 1С:Напарник.
 * Порт _parse_sse_response из 1c-ai-mcp (src/onec_api_client.py), но с потоковой
 * выдачей текста: каждую строку можно скормить по мере прихода.
 */

export interface ToolCall {
  id?: string;
  type?: string;
  function?: { name?: string; arguments?: string };
}

export interface SseParseResult {
  text: string;
  hasToolCalls: boolean;
  hasOnlyReasoning: boolean;
  toolCalls: ToolCall[];
  assistantUuid?: string;
}

// Любой JSON-объект из SSE: формат ответа плавает, поэтому без строгой схемы
type Json = Record<string, any>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

export class SseParser {
  private deltaText = '';
  private finalText = '';
  private hasReasoning = false;
  private hasToolCalls = false;
  private toolCalls: ToolCall[] | undefined;
  // OpenAI-формат: id приходит в первом фрагменте, name/arguments — в следующих
  private toolCallFragments = new Map<number, ToolCall>();
  private assistantUuid: string | undefined;

  /** true — сервер прислал маркер завершения, дальше читать не нужно */
  done = false;

  /** Обработать одну строку SSE-потока */
  feedLine(line: string): void {
    if (this.done || !line.startsWith('data: ')) {
      return;
    }
    const dataStr = line.slice(6);
    if (dataStr.trim() === '[DONE]') {
      this.done = true;
      return;
    }

    let data: unknown;
    try {
      data = JSON.parse(dataStr);
    } catch {
      return;
    }
    if (!isObject(data)) {
      return;
    }

    // После ACK сервер сначала шлёт сырой результат инструмента (role: tool, finished: true),
    // а следом в том же потоке — ответ ассистента. Результат инструмента пропускаем целиком.
    if (data.role === 'tool' || data.type === 'tool') {
      return;
    }

    if (data.role === 'assistant' && data.uuid) {
      this.assistantUuid = data.uuid;
    }

    if ('tool_calls' in data) {
      this.hasToolCalls = true;
      if (Array.isArray(data.tool_calls)) {
        this.toolCalls = data.tool_calls;
      }
    }

    this.handleOpenAiChoices(data);

    if (data.reasoning || data.reasoning_content) {
      this.hasReasoning = true;
    }

    // Legacy: content_delta — строка или объект { content, tool_calls }
    const contentDelta = data.content_delta;
    if (typeof contentDelta === 'string') {
      this.deltaText += contentDelta;
    } else if (isObject(contentDelta)) {
      if (typeof contentDelta.content === 'string') {
        this.deltaText += contentDelta.content;
      }
      if (contentDelta.tool_calls) {
        this.hasToolCalls = true;
        this.toolCalls = contentDelta.tool_calls;
      }
    }

    // Completed: content.text / content.content — финальный текст, перекрывает дельты
    const content = data.content;
    if (isObject(content)) {
      const text = content.text || content.content;
      if (typeof text === 'string' && text) {
        this.finalText = text;
      }
      if (content.tool_calls) {
        this.hasToolCalls = true;
        this.toolCalls = content.tool_calls;
      }
      if (content.reasoning_content) {
        this.hasReasoning = true;
      }
    }

    // Echo сообщения пользователя тоже приходит с finished: true — его пропускаем
    if (data.finished && data.role !== 'user') {
      this.done = true;
    }
  }

  private handleOpenAiChoices(data: Json): void {
    const choice = Array.isArray(data.choices) ? data.choices[0] : undefined;
    if (!isObject(choice)) {
      return;
    }
    const delta = choice.delta;
    if (isObject(delta)) {
      if ('tool_calls' in delta) {
        this.hasToolCalls = true;
        if (Array.isArray(delta.tool_calls)) {
          for (const frag of delta.tool_calls) {
            this.mergeToolCallFragment(frag);
          }
        }
      }
      if (typeof delta.content === 'string') {
        this.deltaText += delta.content;
      }
      if (delta.reasoning || delta.reasoning_content) {
        this.hasReasoning = true;
      }
    }
    if (choice.finish_reason === 'stop') {
      this.done = true;
    }
  }

  private mergeToolCallFragment(frag: unknown): void {
    if (!isObject(frag)) {
      return;
    }
    const index = typeof frag.index === 'number' ? frag.index : 0;
    const entry = this.toolCallFragments.get(index) ?? { function: {} };
    this.toolCallFragments.set(index, entry);
    if (frag.id) entry.id = frag.id;
    if (frag.type) entry.type = frag.type;
    if (isObject(frag.function)) {
      entry.function ??= {};
      if (frag.function.name) entry.function.name = (entry.function.name ?? '') + frag.function.name;
      if (frag.function.arguments) {
        entry.function.arguments = (entry.function.arguments ?? '') + frag.function.arguments;
      }
    }
  }

  /** Текст, который можно показывать пользователю прямо сейчас (без thinking-блоков) */
  get visibleText(): string {
    return stripThinkingTags(this.finalText || this.deltaText, true);
  }

  result(): SseParseResult {
    let toolCalls = this.toolCalls;
    // Фрагменты используются, только если полный список вызовов не пришёл
    if (!toolCalls && this.toolCallFragments.size > 0) {
      toolCalls = [...this.toolCallFragments.entries()].sort(([a], [b]) => a - b).map(([, tc]) => tc);
    }
    const text = (this.finalText || this.deltaText).trim();
    return {
      text,
      hasToolCalls: this.hasToolCalls,
      hasOnlyReasoning: this.hasReasoning && !text,
      toolCalls: toolCalls ?? [],
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

/** Распаковать JSON-обёртку результата внутреннего MCP-инструмента 1С:Напарник */
export function unwrapToolResult(text: string): string {
  let current = text.trim();
  // Результат бывает обёрнут несколько раз — разворачиваем максимум 3 уровня
  for (let i = 0; i < 3; i++) {
    let payload: unknown;
    try {
      payload = JSON.parse(current);
    } catch {
      break;
    }
    if (!isObject(payload)) {
      break;
    }

    let extracted: string | undefined;
    if (typeof payload.content === 'string') {
      extracted = payload.content;
    } else if (Array.isArray(payload.content)) {
      const parts = payload.content
        .filter((item: unknown) => isObject(item) && item.type === 'text')
        .map((item: Json) => item.text ?? '');
      if (parts.length > 0) {
        extracted = parts.join('\n');
      }
    }
    if (extracted === undefined && typeof payload.structuredContent === 'string') {
      extracted = payload.structuredContent;
    }

    if (!extracted || !extracted.trim()) {
      break;
    }
    current = extracted.trim();
  }
  return current;
}

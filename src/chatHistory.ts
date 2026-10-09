// Только тип: модуль можно тестировать без VS Code
import type * as vscode from 'vscode';

export interface ChatEntry {
  // step — шаг работы с проектом («Читаю …»); compact — пересказ, которым заменили историю (/compact)
  role: 'user' | 'assistant' | 'error' | 'step' | 'compact';
  text: string;
  /** Для сообщения пользователя: какой файл редактора был приложен («chatHistory.ts · строки 10–24»); для пересказа — как сжат */
  context?: string;
}

export interface SavedChat {
  id: string;
  title: string;
  updatedAt: number;
  entries: ChatEntry[];
  /** Дискуссия на сервере — чтобы продолжить старый чат с сохранённым контекстом */
  conversationId?: string;
  lastAssistantUuid?: string;
  /** Хеш последнего отправленного контекста редактора — чтобы не слать тот же неизменённый файл повторно */
  lastEditorContext?: string;
  /** Хеш последнего отправленного блока приложенных файлов — чипы остаются, неизменённое повторно не шлём */
  lastAttachments?: string;
  /** Чипы контекста этого чата — пути от корня, папки с «/», фрагменты «путь#L120-180» */
  attachments?: string[];
  /** Модели уже отправлена инструкция по командам работы с проектом */
  agentPrimed?: boolean;
  /** Доступ к проекту выключили после инструкции — модели уже сказано не использовать команды */
  agentPaused?: boolean;
  /** Пересказ после /compact, ещё не отправленный: уйдёт первым сообщением новой дискуссии */
  compactSummary?: string;
  /** Заполненность контекста дискуссии после последнего ответа */
  contextUsage?: { tokens: number; limit: number };
  /** Подсказка «контекст почти заполнен» уже показана — до следующего сжатия не повторяем */
  contextHinted?: boolean;
  /** Сервис отбросил начало разговора (контекст переполнился) — пересказ в той же дискуссии его уже не помнит */
  contextTruncated?: boolean;
}

const STORAGE_KEY = 'naparnik.chats';
const MAX_CHATS = 50;
const TITLE_LENGTH = 60;

/** История чатов в globalState: общая для всех окон VS Code, переживает перезапуск */
export class ChatHistory {
  constructor(private readonly state: vscode.Memento) {}

  /** Чаты от новых к старым */
  list(): SavedChat[] {
    return [...this.state.get<SavedChat[]>(STORAGE_KEY, [])].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** touch = false — сохранить без смены времени (например, изменились только чипы), порядок истории тот же */
  async save(chat: SavedChat, touch = true): Promise<void> {
    if (chat.entries.length === 0) {
      return; // пустые чаты не храним
    }
    if (touch) chat.updatedAt = Date.now();
    const others = this.list().filter((c) => c.id !== chat.id);
    await this.state.update(STORAGE_KEY, [chat, ...others].slice(0, MAX_CHATS));
  }

  async delete(id: string): Promise<void> {
    await this.state.update(
      STORAGE_KEY,
      this.list().filter((c) => c.id !== id),
    );
  }

  async clear(): Promise<void> {
    await this.state.update(STORAGE_KEY, []);
  }
}

export function createChat(): SavedChat {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: '', updatedAt: Date.now(), entries: [] };
}

/** Заголовок чата — начало первого вопроса в одну строку */
export function makeTitle(text: string): string {
  const line = text.replace(/```[\s\S]*?(```|$)/g, ' [код] ').replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LENGTH ? line.slice(0, TITLE_LENGTH - 1) + '…' : line || 'Без названия';
}

// Только тип: модуль можно тестировать без VS Code
import type * as vscode from 'vscode';

export interface ChatEntry {
  // step — шаг работы с проектом («Читаю …»); compact — пересказ, которым заменили историю (/compact)
  role: 'user' | 'assistant' | 'error' | 'step' | 'compact';
  text: string;
  /** Ответ прерван (остановка, обрыв, ошибка): текст показан пользователю, но модель его не помнит */
  interrupted?: boolean;
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
  /** Хеши приложенных файлов, уже отправленных в этой дискуссии (путь → хеш): неизменённые повторно не шлём */
  sentFiles?: Record<string, string>;
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

  /** Чаты от новых к старым. Повреждённые записи пропускаются — при следующем сохранении они исчезнут */
  list(): SavedChat[] {
    const raw = this.state.get<unknown>(STORAGE_KEY, []);
    const chats = Array.isArray(raw) ? raw.filter(isSavedChat) : [];
    return chats
      .map((chat) => ((chat.entries as unknown[]).every(isChatEntry) ? chat : { ...chat, entries: chat.entries.filter(isChatEntry) }))
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
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

function isSavedChat(value: unknown): value is SavedChat {
  const chat = value as SavedChat | null;
  return typeof chat === 'object' && chat !== null && typeof chat.id === 'string' && Array.isArray(chat.entries);
}

function isChatEntry(value: unknown): value is ChatEntry {
  const entry = value as ChatEntry | null;
  return typeof entry === 'object' && entry !== null && typeof entry.role === 'string' && typeof entry.text === 'string';
}

export function createChat(): SavedChat {
  return { id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title: '', updatedAt: Date.now(), entries: [] };
}

/** Заголовок чата — начало первого вопроса в одну строку */
export function makeTitle(text: string): string {
  const line = text.replace(/```[\s\S]*?(```|$)/g, ' [код] ').replace(/\s+/g, ' ').trim();
  return line.length > TITLE_LENGTH ? line.slice(0, TITLE_LENGTH - 1) + '…' : line || 'Без названия';
}

// Только тип: модуль можно тестировать без VS Code
import type * as vscode from 'vscode';

export interface ChatEntry {
  // step — шаг работы с проектом («Читаю …»)
  role: 'user' | 'assistant' | 'error' | 'step';
  text: string;
}

export interface SavedChat {
  id: string;
  title: string;
  updatedAt: number;
  entries: ChatEntry[];
  /** Дискуссия на сервере — чтобы продолжить старый чат с сохранённым контекстом */
  conversationId?: string;
  lastAssistantUuid?: string;
  /** Модели уже отправлена инструкция по командам работы с проектом */
  agentPrimed?: boolean;
  /** Доступ к проекту выключили после инструкции — модели уже сказано не использовать команды */
  agentPaused?: boolean;
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

  async save(chat: SavedChat): Promise<void> {
    if (chat.entries.length === 0) {
      return; // пустые чаты не храним
    }
    chat.updatedAt = Date.now();
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

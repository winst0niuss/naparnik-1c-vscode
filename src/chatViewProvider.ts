import * as vscode from 'vscode';
import { NaparnikClient } from './api/client';
import { TokenStore } from './tokenStore';
import { ChatHistory, SavedChat, createChat, makeTitle } from './chatHistory';

/** Сообщения из webview в расширение */
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'showHistory' }
  | { type: 'setToken' }
  | { type: 'insertCode'; code: string };

/** Запрос, который выполняется в фоне — у каждого чата свой */
interface RunningRequest {
  chat: SavedChat;
  abort: AbortController;
  // Состояние стрима, чтобы показать его при возврате в чат
  partial: string;
  toolNames?: string[];
}

export class ChatViewProvider implements vscode.WebviewViewProvider {
  static readonly viewId = 'naparnik.chat';

  private view: vscode.WebviewView | undefined;
  private chat: SavedChat = createChat();
  private running = new Map<string, RunningRequest>();
  // Сообщение, отправленное до того, как панель успела открыться
  private pendingMessage: string | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tokens: TokenStore,
    private readonly history: ChatHistory,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.html = this.renderHtml(view.webview);
    view.webview.onDidReceiveMessage((msg: WebviewMessage) => this.handleMessage(msg));
    view.onDidDispose(() => (this.view = undefined));
  }

  /** Отправить сообщение из кода (команда «спросить о выделенном») */
  async ask(text: string): Promise<void> {
    if (this.view) {
      this.view.show(true);
      await this.send(text);
    } else {
      // Открываем панель; отправим, когда webview пришлёт 'ready'
      this.pendingMessage = text;
      await vscode.commands.executeCommand(`${ChatViewProvider.viewId}.focus`);
    }
  }

  newChat(): void {
    this.openChat(createChat());
  }

  /** Список прошлых чатов: выбрать — открыть, корзина — удалить */
  async showHistory(): Promise<void> {
    type Item = vscode.QuickPickItem & { chat?: SavedChat; clearAll?: boolean };
    const deleteButton: vscode.QuickInputButton = { iconPath: new vscode.ThemeIcon('trash'), tooltip: 'Удалить чат' };

    const toItems = (): Item[] => {
      const chats = this.history.list();
      if (chats.length === 0) {
        return [{ label: 'История пуста', alwaysShow: true }];
      }
      return [
        ...chats.map((chat) => {
          const icon = this.running.has(chat.id)
            ? '$(loading~spin) '
            : chat.id === this.chat.id
              ? '$(comment-discussion) '
              : '';
          return {
            label: icon + chat.title,
            description: this.running.has(chat.id) ? 'отвечает…' : formatDate(chat.updatedAt),
            detail: `${chat.entries.filter((e) => e.role === 'user').length} вопр.`,
            buttons: [deleteButton],
            chat,
          };
        }),
        { label: '', kind: vscode.QuickPickItemKind.Separator },
        { label: '$(clear-all) Очистить всю историю', clearAll: true },
      ];
    };

    const pick = vscode.window.createQuickPick<Item>();
    pick.title = 'История чатов 1С:Напарник';
    pick.placeholder = 'Поиск по названию';
    pick.matchOnDescription = true;
    pick.items = toItems();

    pick.onDidTriggerItemButton(async ({ item }) => {
      if (!item.chat) return;
      this.running.get(item.chat.id)?.abort.abort();
      await this.history.delete(item.chat.id);
      if (item.chat.id === this.chat.id) this.newChat();
      pick.items = toItems();
    });
    pick.onDidAccept(async () => {
      const item = pick.selectedItems[0];
      pick.hide();
      if (item?.chat) {
        this.openChat(item.chat);
      } else if (item?.clearAll) {
        const answer = await vscode.window.showWarningMessage('Удалить все сохранённые чаты?', { modal: true }, 'Удалить');
        if (answer === 'Удалить') {
          this.running.forEach((r) => r.abort.abort());
          await this.history.clear();
          this.newChat();
        }
      }
    });
    pick.onDidHide(() => pick.dispose());
    pick.show();
  }

  /** Показать чат. Идущие запросы других чатов не прерываются — они продолжаются в фоне */
  private openChat(chat: SavedChat): void {
    // Если чат сейчас отвечает — берём живой объект, а не копию из истории
    this.chat = this.running.get(chat.id)?.chat ?? chat;
    this.renderCurrentChat();
  }

  private renderCurrentChat(): void {
    this.post({ type: 'restore', history: this.chat.entries });
    const run = this.running.get(this.chat.id);
    if (run) {
      this.post({ type: 'assistantStart' });
      if (run.toolNames) this.post({ type: 'toolCalls', names: run.toolNames });
      if (run.partial) this.post({ type: 'assistantText', text: run.partial });
    }
  }

  async refreshTokenState(): Promise<void> {
    this.post({ type: 'tokenState', hasToken: Boolean(await this.tokens.get()) });
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.renderCurrentChat();
        await this.refreshTokenState();
        if (this.pendingMessage) {
          const text = this.pendingMessage;
          this.pendingMessage = undefined;
          await this.send(text);
        }
        break;
      case 'send':
        await this.send(msg.text);
        break;
      case 'stop':
        this.running.get(this.chat.id)?.abort.abort();
        break;
      case 'newChat':
        this.newChat();
        break;
      case 'showHistory':
        await this.showHistory();
        break;
      case 'setToken':
        await vscode.commands.executeCommand('naparnik.setToken');
        break;
      case 'insertCode':
        await insertIntoEditor(msg.code);
        break;
    }
  }

  private async send(text: string): Promise<void> {
    text = text.trim();
    // В одном чате — один запрос за раз; в других чатах можно спрашивать параллельно
    if (!text || this.running.has(this.chat.id)) {
      return;
    }

    const token = await this.tokens.get();
    if (!token) {
      this.post({ type: 'tokenState', hasToken: false });
      return;
    }

    // Запоминаем чат: пользователь может переключиться, а ответ должен попасть сюда
    const chat = this.chat;
    if (chat.entries.length === 0) {
      chat.title = makeTitle(text);
    }
    chat.entries.push({ role: 'user', text });
    const run: RunningRequest = { chat, abort: new AbortController(), partial: '' };
    this.running.set(chat.id, run);
    // Сохраняем сразу, чтобы чат появился в истории, пока идёт ответ
    await this.history.save(chat);

    // Сообщения в webview — только если этот чат сейчас на экране
    const postIfVisible = (message: object) => {
      if (this.chat === chat) this.post(message);
    };
    postIfVisible({ type: 'userMessage', text });
    postIfVisible({ type: 'assistantStart' });

    try {
      const client = new NaparnikClient({ token, ...readSettings() });
      chat.conversationId ??= await client.createConversation(run.abort.signal);
      const answer = await client.sendMessage(
        chat.conversationId,
        text,
        chat.lastAssistantUuid,
        {
          onText: (partial) => {
            run.partial = partial;
            postIfVisible({ type: 'assistantText', text: partial });
          },
          onToolCalls: (names) => {
            run.toolNames = names;
            postIfVisible({ type: 'toolCalls', names });
          },
        },
        run.abort.signal,
      );
      chat.lastAssistantUuid = answer.assistantUuid;
      chat.entries.push({ role: 'assistant', text: answer.text });
      postIfVisible({ type: 'assistantDone', text: answer.text });
      this.notifyIfHidden(chat);
    } catch (err) {
      const message = run.abort.signal.aborted ? 'Остановлено' : errorMessage(err);
      chat.entries.push({ role: 'error', text: message });
      postIfVisible({ type: 'error', message });
      // После сбоя начинаем новую дискуссию: старая могла остаться в неконсистентном состоянии
      chat.conversationId = undefined;
      chat.lastAssistantUuid = undefined;
    } finally {
      this.running.delete(chat.id);
      // Удалённый во время ответа чат обратно в историю не возвращаем
      if (!run.abort.signal.aborted || this.history.list().some((c) => c.id === chat.id)) {
        await this.history.save(chat);
      }
    }
  }

  /** Ответ пришёл в чат, который пользователь сейчас не видит, — сообщаем */
  private notifyIfHidden(chat: SavedChat): void {
    if (this.chat === chat && this.view?.visible) {
      return;
    }
    void vscode.window
      .showInformationMessage(`Напарник ответил в чате «${chat.title}»`, 'Открыть')
      .then((choice) => {
        if (choice === 'Открыть') {
          this.openChat(chat);
          this.view?.show(true);
        }
      });
  }

  private post(message: object): void {
    void this.view?.webview.postMessage(message);
  }

  private renderHtml(webview: vscode.Webview): string {
    const mediaUri = (file: string) => webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', file));
    const nonce = createNonce();
    return /* html */ `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${mediaUri('chat.css')}">
  <title>1С:Напарник</title>
</head>
<body>
  <div id="token-banner" class="banner hidden">
    <p>Чтобы начать, укажите API-токен 1С:Напарник (code.1c.ai → профиль → токены).</p>
    <button id="set-token">Задать токен</button>
  </div>
  <div id="messages"></div>
  <form id="composer">
    <textarea id="input" rows="3" placeholder="Задай мне вопрос…&#10;Enter — отправить, Shift+Enter — новая строка"></textarea>
    <div class="actions">
      <button type="button" id="stop" class="secondary hidden">Стоп</button>
      <button type="submit" id="send">Отправить</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${mediaUri('chat.js')}"></script>
</body>
</html>`;
  }
}

function formatDate(ms: number): string {
  return new Date(ms).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function readSettings() {
  const cfg = vscode.workspace.getConfiguration('naparnik');
  return {
    baseUrl: cfg.get<string>('baseUrl', 'https://code.1c.ai'),
    authFormat: cfg.get<'plain' | 'bearer'>('authFormat', 'plain'),
    skillName: cfg.get<string>('skillName', 'custom'),
    timeoutMs: cfg.get<number>('timeoutSeconds', 120) * 1000,
  };
}

async function insertIntoEditor(code: string): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    await vscode.env.clipboard.writeText(code);
    void vscode.window.showInformationMessage('Нет открытого редактора — код скопирован в буфер обмена.');
    return;
  }
  await editor.edit((edit) => edit.replace(editor.selection, code));
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) {
    // fetch оборачивает сетевые ошибки в TypeError с причиной в cause
    const cause = (err as { cause?: unknown }).cause;
    if (err.name === 'TimeoutError') {
      return 'Превышен таймаут ответа. Его можно увеличить в настройке naparnik.timeoutSeconds.';
    }
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

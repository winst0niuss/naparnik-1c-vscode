import * as vscode from 'vscode';
import { NaparnikClient } from './api/client';
import { TokenStore } from './tokenStore';
import { ChatHistory, SavedChat, createChat, makeTitle } from './chatHistory';
import { AGENT_UNAVAILABLE_TOOL_HINT, MAX_AGENT_STEPS, buildAgentPrompt, describeCommand, parseCommands, stripCommandsForDisplay } from './agent/protocol';
import { WorkspaceTools } from './agent/workspaceTools';
import { EditPreview, PendingEdit } from './agent/editPreview';

const PROJECT_ACCESS_KEY = 'naparnik.projectAccess';
const PROJECT_CONSENT_KEY = 'naparnik.projectAccessConsent';

/** Сообщения из webview в расширение */
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'newChat' }
  | { type: 'showHistory' }
  | { type: 'setToken' }
  | { type: 'toggleProject' }
  | { type: 'resolveEdit'; id: number; accepted: boolean }
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
  // Правки, ждущие решения, — чтобы показать карточку снова после перерисовки чата
  private pendingEdits = new Map<number, PendingEdit>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tokens: TokenStore,
    private readonly history: ChatHistory,
    // workspaceState — переключатель доступа хранится отдельно для каждого проекта
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    private readonly preview: EditPreview,
  ) {
    preview.onDidStart((edit) => {
      this.pendingEdits.set(edit.id, edit);
      this.post({ type: 'editPending', ...edit });
    });
    preview.onDidEnd(({ id, accepted }) => {
      this.pendingEdits.delete(id);
      this.post({ type: 'editResolved', id, accepted });
    });
  }

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
    this.pendingEdits.forEach((edit) => this.post({ type: 'editPending', ...edit }));
  }

  async refreshTokenState(): Promise<void> {
    this.post({ type: 'tokenState', hasToken: Boolean(await this.tokens.get()) });
  }

  private get projectAccess(): boolean {
    return this.workspaceState.get<boolean>(PROJECT_ACCESS_KEY, false) && Boolean(vscode.workspace.workspaceFolders?.length);
  }

  private postProjectState(): void {
    this.post({
      type: 'projectAccess',
      on: this.projectAccess,
      available: Boolean(vscode.workspace.workspaceFolders?.length),
    });
  }

  /** Включить/выключить доступ к файлам проекта. При первом включении — предупреждение о передаче данных */
  async toggleProjectAccess(): Promise<void> {
    if (this.projectAccess) {
      await this.workspaceState.update(PROJECT_ACCESS_KEY, false);
      this.postProjectState();
      return;
    }
    if (!vscode.workspace.workspaceFolders?.length) {
      void vscode.window.showWarningMessage('Откройте папку проекта (File → Open Folder), чтобы Напарник мог её читать.');
      return;
    }
    if (!this.globalState.get<boolean>(PROJECT_CONSENT_KEY)) {
      const answer = await vscode.window.showWarningMessage(
        'Включить доступ к проекту?',
        {
          modal: true,
          detail:
            'Напарник сможет смотреть структуру проекта, читать и искать файлы. Прочитанные файлы отправляются в сервис 1С:Напарник (code.1c.ai). ' +
            'Изменения файлов применяются только после вашего подтверждения.',
        },
        'Включить',
      );
      if (answer !== 'Включить') return;
      await this.globalState.update(PROJECT_CONSENT_KEY, true);
    }
    await this.workspaceState.update(PROJECT_ACCESS_KEY, true);
    this.postProjectState();
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.renderCurrentChat();
        this.postProjectState();
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
      case 'toggleProject':
        await this.toggleProjectAccess();
        break;
      case 'resolveEdit':
        this.preview.resolve(msg.id, msg.accepted);
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

      const tools = this.projectAccess ? WorkspaceTools.forCurrentWorkspace(this.preview.confirm, run.abort.signal) : undefined;
      let message = text;
      if (tools && !chat.agentPrimed) {
        // Первое сообщение с доступом к проекту: инструкция по командам + дерево проекта
        message = buildAgentPrompt(await tools.tree(), text);
        chat.agentPrimed = true;
      } else if (tools && chat.agentPaused) {
        message = `(Доступ к проекту снова включён — можно использовать @-команды.)\n\n${text}`;
      } else if (!tools && chat.agentPrimed && !chat.agentPaused) {
        message = `(Доступ к проекту сейчас выключен — не используй команды, отвечай сразу.)\n\n${text}`;
      }
      // Модель уже знает о выключенном доступе — повторять не нужно, но при включении сообщить
      chat.agentPaused = chat.agentPrimed && !tools;

      // Агентный цикл: ответ с командами → выполняем → отправляем результат → снова ответ
      for (let step = 0; ; step++) {
        const answer = await client.sendMessage(
          chat.conversationId,
          message,
          chat.lastAssistantUuid,
          {
            onText: (partial) => {
              run.partial = chat.agentPrimed ? stripCommandsForDisplay(partial) : partial;
              postIfVisible({ type: 'assistantText', text: run.partial });
            },
            onToolCalls: (names) => {
              run.toolNames = names;
              postIfVisible({ type: 'toolCalls', names });
            },
            unavailableToolHint: tools ? AGENT_UNAVAILABLE_TOOL_HINT : undefined,
          },
          run.abort.signal,
        );
        chat.lastAssistantUuid = answer.assistantUuid;

        const commands = tools ? parseCommands(answer.text) : [];
        if (commands.length === 0) {
          chat.entries.push({ role: 'assistant', text: answer.text });
          postIfVisible({ type: 'assistantDone', text: answer.text });
          this.notifyIfHidden(chat);
          break;
        }
        if (step >= MAX_AGENT_STEPS) {
          throw new Error(`Напарник не уложился в ${MAX_AGENT_STEPS} шагов. Попробуйте уточнить вопрос.`);
        }

        const results: string[] = [];
        for (const cmd of commands) {
          const description = describeCommand(cmd);
          chat.entries.push({ role: 'step', text: description });
          postIfVisible({ type: 'step', text: description });
          results.push(`### ${description}\n${await tools!.run(cmd)}`);
          // Пока пользователь смотрел diff, запрос могли остановить
          if (run.abort.signal.aborted) throw new Error('Остановлено');
        }
        run.partial = '';
        postIfVisible({ type: 'assistantText', text: '' });
        message = `Результаты команд:\n\n${results.join('\n\n')}`;
      }
    } catch (err) {
      const message = run.abort.signal.aborted ? 'Остановлено' : errorMessage(err);
      chat.entries.push({ role: 'error', text: message });
      postIfVisible({ type: 'error', message });
      // После сбоя начинаем новую дискуссию: старая могла остаться в неконсистентном состоянии
      chat.conversationId = undefined;
      chat.lastAssistantUuid = undefined;
      chat.agentPrimed = false;
      chat.agentPaused = false;
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
    <div class="composer-tools">
      <button type="button" id="project-toggle" class="toggle" title="Разрешить Напарнику смотреть и читать файлы открытого проекта">
        <span class="toggle-dot"></span>Доступ к проекту
      </button>
    </div>
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
      return 'Превышено время ожидания ответа.';
    }
    return cause instanceof Error ? `${err.message}: ${cause.message}` : err.message;
  }
  return String(err);
}

function createNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  return Array.from({ length: 32 }, () => chars[Math.floor(Math.random() * chars.length)]).join('');
}

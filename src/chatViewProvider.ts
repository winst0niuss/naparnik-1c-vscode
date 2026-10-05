import * as vscode from 'vscode';
import { NaparnikClient } from './api/client';
import { TokenStore } from './tokenStore';
import { ChatHistory, SavedChat, createChat, makeTitle } from './chatHistory';
import {
  AGENT_UNAVAILABLE_TOOL_HINT,
  MAX_AGENT_STEPS,
  buildAgentPrompt,
  describeCommand,
  findUnfinishedWrite,
  looksLikeMalformedEdit,
  MALFORMED_EDIT_HINT,
  parseCommands,
  stripCommandsForDisplay,
} from './agent/protocol';
import { INIT_PROMPT, MAKE_RULES_PROMPT, RULES_DIR, SLASH_COMMANDS, helpText, parseSlash } from './slashCommands';
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
  /** Модели уже напомнили формат правки — второй раз не напоминаем, чтобы не зациклиться */
  formatReminded?: boolean;
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

  /** Сообщение из чата: слэш-команда выполняется в расширении, остальное уходит Напарнику */
  private async handleInput(text: string): Promise<void> {
    const slash = parseSlash(text);
    if (!slash) {
      await this.send(text);
      return;
    }
    switch (slash.name) {
      case 'clear':
        this.newChat();
        break;
      case 'history':
        await this.showHistory();
        break;
      case 'project':
        await this.toggleProjectAccess();
        break;
      case 'stop': {
        const run = this.running.get(this.chat.id);
        if (run) run.abort.abort();
        else this.info('Сейчас нечего останавливать.');
        break;
      }
      case 'token':
        await vscode.commands.executeCommand('naparnik.setToken');
        break;
      case 'help':
        this.info(helpText());
        break;
      case 'exit':
        this.running.get(this.chat.id)?.abort.abort();
        await this.closeView();
        break;
      case 'init':
        if (await this.ensureProjectAccess('/init')) {
          await this.send('/init', INIT_PROMPT);
        }
        break;
      case 'make-rules':
        if (this.chat.entries.length === 0) {
          this.info('В этом чате пока нечего записывать: `/make-rules` собирает правила из уже состоявшегося разговора.');
        } else if (await this.ensureProjectAccess('/make-rules')) {
          await this.send('/make-rules', MAKE_RULES_PROMPT);
        }
        break;
      case 'rules':
        await this.showRules();
        break;
      default:
        this.info(`Нет команды \`/${slash.name}\`. Список команд — \`/help\`.`);
    }
  }

  /** Подсказка в чате от расширения (не от модели и не в историю) */
  private info(markdown: string): void {
    this.post({ type: 'info', text: markdown });
  }

  /** /init и /make-rules работают с файлами — без доступа к проекту предлагаем его включить */
  private async ensureProjectAccess(command: string): Promise<boolean> {
    if (!this.projectAccess) {
      await this.toggleProjectAccess();
    }
    if (!this.projectAccess) {
      this.info(`Для \`${command}\` нужен доступ к проекту: откройте папку и включите «Доступ к проекту».`);
      return false;
    }
    return true;
  }

  private async closeView(): Promise<void> {
    // Панель может быть в боковой панели или внизу — пробуем скрыть сам view, затем запасные варианты
    for (const command of [`${ChatViewProvider.viewId}.removeView`, 'workbench.action.closePanel']) {
      try {
        await vscode.commands.executeCommand(command);
        return;
      } catch {
        // команда недоступна в этой версии VS Code — пробуем следующую
      }
    }
  }

  /** /rules: список правил из .rules, открыть или создать новое */
  private async showRules(): Promise<void> {
    const tools = WorkspaceTools.forCurrentWorkspace(this.preview.confirm);
    if (!tools) {
      void vscode.window.showWarningMessage('Откройте папку проекта, чтобы работать с правилами.');
      return;
    }
    type Item = vscode.QuickPickItem & { uri?: vscode.Uri; action?: 'new' | 'make' };
    const files = await tools.ruleFiles();
    const items: Item[] = [
      ...files.map((uri) => ({ label: `$(file) ${vscode.workspace.asRelativePath(uri)}`, uri })),
      ...(files.length > 0 ? [{ label: '', kind: vscode.QuickPickItemKind.Separator } as Item] : []),
      { label: '$(add) Новое правило…', description: `файл в ${RULES_DIR}/`, action: 'new' },
      { label: '$(sparkle) Записать правила из этого чата', description: '/make-rules', action: 'make' },
    ];
    const pick = await vscode.window.showQuickPick(items, {
      title: files.length > 0 ? 'Правила проекта' : `Правил пока нет — папка ${RULES_DIR}/ появится с первым правилом`,
      placeHolder: 'Выберите файл или действие',
    });
    if (pick?.uri) {
      await vscode.window.showTextDocument(pick.uri);
    } else if (pick?.action === 'make') {
      await this.handleInput('/make-rules');
    } else if (pick?.action === 'new') {
      const name = await vscode.window.showInputBox({
        title: 'Новое правило',
        prompt: 'Тема правила — станет именем файла',
        placeHolder: 'code-style',
        validateInput: (v) => (/^[\w\-а-яё ]+$/i.test(v.trim()) ? undefined : 'Только буквы, цифры, «-» и пробелы'),
      });
      if (!name?.trim()) return;
      const fileName = name.trim().replace(/\s+/g, '-');
      const uri = vscode.Uri.joinPath(tools.rootUri, RULES_DIR, `${fileName}.md`);
      try {
        await vscode.workspace.fs.stat(uri);
      } catch {
        await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(`# ${name.trim()}\n\n- \n`));
      }
      await vscode.window.showTextDocument(uri);
    }
  }

  private async handleMessage(msg: WebviewMessage): Promise<void> {
    switch (msg.type) {
      case 'ready':
        this.post({ type: 'commands', list: SLASH_COMMANDS });
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
        await this.handleInput(msg.text);
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

  /**
   * Отправить вопрос. text — то, что видит пользователь в чате и истории;
   * modelText — что уходит модели (для /init и /make-rules это развёрнутая инструкция).
   */
  private async send(text: string, modelText?: string): Promise<void> {
    text = text.trim();
    // В одном чате — один запрос за раз; в других чатах можно спрашивать параллельно
    if (!text) {
      return;
    }
    if (this.running.has(this.chat.id)) {
      this.info('Напарник ещё отвечает в этом чате. Дождитесь ответа или остановите его — `/stop`.');
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
      const question = modelText ?? text;
      let message = question;
      if (tools && !chat.agentPrimed) {
        // Первое сообщение с доступом к проекту: инструкция по командам, дерево, документация и правила
        message = buildAgentPrompt(await tools.tree(), question, await tools.projectContext());
        chat.agentPrimed = true;
      } else if (tools && chat.agentPaused) {
        message = `(Доступ к проекту снова включён — можно использовать @-команды.)\n\n${question}`;
      } else if (!tools && chat.agentPrimed && !chat.agentPaused) {
        message = `(Доступ к проекту сейчас выключен — не используй команды, отвечай сразу.)\n\n${question}`;
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
              // Модель пишет содержимое файла — вместе с текстом передаём прогресс, чтобы показать его вместо «думает»
              const writing = chat.agentPrimed ? findUnfinishedWrite(partial) : undefined;
              postIfVisible({ type: 'assistantText', text: run.partial, writing });
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
        // Правка без @edit_file — один раз напоминаем формат, а не показываем блок как ответ
        if (tools && commands.length === 0 && looksLikeMalformedEdit(answer.text) && !run.formatReminded && step < MAX_AGENT_STEPS) {
          run.formatReminded = true;
          run.partial = '';
          postIfVisible({ type: 'assistantText', text: '' });
          message = MALFORMED_EDIT_HINT;
          continue;
        }
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
    <div id="slash-menu" class="slash-menu hidden" role="listbox"></div>
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
    timeoutMs: cfg.get<number>('timeoutSeconds', 300) * 1000,
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

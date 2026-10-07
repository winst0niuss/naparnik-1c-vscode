import * as vscode from 'vscode';
import { createHash } from 'node:crypto';
import { ApiError, NaparnikClient } from './api/client';
import { TokenStore } from './tokenStore';
import { ChatHistory, SavedChat, createChat, makeTitle } from './chatHistory';
import { AgentCommand, MAX_AGENT_STEPS, buildAgentPrompt, findUnfinishedWrite, stripCommandsForDisplay } from './agent/protocol';
import { runAgentLoop } from './agent/agentLoop';
import { INIT_PROMPT, MAKE_RULES_PROMPT, RULES_DIR, SLASH_COMMANDS, helpText, parseSlash } from './slashCommands';
import { WorkspaceTools } from './agent/workspaceTools';
import { EditPreview, PendingEdit } from './agent/editPreview';
import { EditorContextTracker } from './editorContextTracker';
import { contextLabel, formatEditorContext } from './agent/editorContext';
import {
  FoundFile,
  IMPORT_SOURCES,
  ImportState,
  buildImportPrompt,
  classifyProjectFile,
  importDone,
  makeFoundFile,
  parseImportArgs,
  readUserFiles,
  scanReport,
  selectForImport,
} from './agent/importSources';
import {
  MAX_FOLDER_FILES_READ,
  MAX_MENTION_FILE_CHARS,
  MAX_MENTION_TOTAL_CHARS,
  findMentions,
  folderFiles,
  formatMentionedFiles,
  pickFolderFiles,
  rankPaths,
  resolveMention,
  shortList,
  withFolders,
} from './agent/mentions';

/** /init выполнен, только если NAPARNIK.md создан или изменён */
function initDone(executed: AgentCommand[]): string | undefined {
  const written = executed.some((c) => (c.kind === 'create_file' || c.kind === 'edit_file') && /(^|\/)NAPARNIK\.md$/i.test(c.path));
  return written ? undefined : 'Задача не выполнена: NAPARNIK.md ещё не создан. Если информации достаточно — создай его командой @create_file NAPARNIK.md … @end; если нет — дочитай нужное командами.';
}

const PROJECT_ACCESS_KEY = 'naparnik.projectAccess';
// Лимит шагов для /init и /make-rules: им нужно изучить проект, обычному вопросу — нет
const EXPLORE_MAX_STEPS = 25;
const PROJECT_CONSENT_KEY = 'naparnik.projectAccessConsent';
// Хеши файлов, перенесённых /import, — отдельно для каждого проекта
const IMPORT_STATE_KEY = 'naparnik.importState';
const SYNTAX_CHECK_STEP = '🧪 Проверяю синтаксис';
// Список файлов для @-упоминаний строится обходом проекта — между нажатиями клавиш берём из кеша
const MENTION_INDEX_TTL_MS = 30_000;
const MAX_MENTION_INDEX_FILES = 50_000;

/** Сообщения из webview в расширение */
type WebviewMessage =
  | { type: 'ready' }
  | { type: 'send'; text: string }
  | { type: 'stop' }
  | { type: 'setToken' }
  | { type: 'toggleProject' }
  | { type: 'resolveEdit'; id: number; accepted: boolean }
  | { type: 'toggleEditorContext' }
  | { type: 'insertCode'; code: string }
  | { type: 'mentionQuery'; query: string };

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
  private pendingMessage: { text: string; mode: 'force' | false } | undefined;
  // Правки, ждущие решения, — чтобы показать карточку снова после перерисовки чата
  private pendingEdits = new Map<number, PendingEdit>();
  // Пользователь выключил контекст редактора кликом по чипу — до смены файла
  private editorContextOff = false;
  private editorContextUri: string | undefined;
  private mentionIndex: { root: string; at: number; paths: Promise<string[]> } | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly tokens: TokenStore,
    private readonly history: ChatHistory,
    // workspaceState — переключатель доступа хранится отдельно для каждого проекта
    private readonly workspaceState: vscode.Memento,
    private readonly globalState: vscode.Memento,
    private readonly preview: EditPreview,
    private readonly editorContext: EditorContextTracker,
  ) {
    editorContext.onDidChange(() => {
      // Выключение действует, пока открыт тот же файл; новый файл — контекст снова включён
      const uri = editorContext.uri?.toString();
      if (uri !== this.editorContextUri) this.editorContextOff = false;
      this.editorContextUri = uri;
      this.postEditorContext();
    });
    // Карточка правки — только в чате, где её предложили: иначе Enter в другом чате применил бы чужую правку
    preview.onDidStart((edit) => {
      this.pendingEdits.set(edit.id, edit);
      if (edit.owner === this.chat.id) this.post({ type: 'editPending', ...edit });
    });
    preview.onDidEnd(({ id, accepted, owner }) => {
      this.pendingEdits.delete(id);
      if (owner === this.chat.id) this.post({ type: 'editResolved', id, accepted });
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

  /** Вопрос о выделенном коде (контекстное меню редактора): выделение прикладывается как контекст */
  async ask(text: string, withEditorContext = true): Promise<void> {
    const mode = withEditorContext ? 'force' : false;
    if (this.view) {
      this.view.show(true);
      await this.send(text, undefined, mode);
    } else {
      // Открываем панель; отправим, когда webview пришлёт 'ready'
      this.pendingMessage = { text, mode };
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
    this.pendingEdits.forEach((edit) => {
      if (edit.owner === this.chat.id) this.post({ type: 'editPending', ...edit });
    });
  }

  /** Чип над полем ввода: какой файл и выделение будут приложены к следующему сообщению */
  private postEditorContext(): void {
    const info = this.editorContext.describe();
    this.post({ type: 'editorContext', label: info?.label ?? null, path: info?.path, enabled: !this.editorContextOff });
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
      await this.send(text, undefined, true);
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
          // Изучение проекта требует больше шагов, чем обычный вопрос
          await this.send('/init', INIT_PROMPT, false, EXPLORE_MAX_STEPS, initDone);
        }
        break;
      case 'make-rules':
        if (this.chat.entries.length === 0) {
          this.info('В этом чате пока нечего записывать: `/make-rules` собирает правила из уже состоявшегося разговора.');
        } else if (await this.ensureProjectAccess('/make-rules')) {
          await this.send('/make-rules', MAKE_RULES_PROMPT, false, EXPLORE_MAX_STEPS);
        }
        break;
      case 'rules':
        await this.showRules();
        break;
      case 'import':
        await this.importRules(slash.args);
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

  /** Инструкции других ИИ-инструментов: проектные (без игнорируемых git) и пользовательские из домашней папки */
  private async scanImportSources(tools: WorkspaceTools): Promise<FoundFile[]> {
    const found: FoundFile[] = [];
    for (const rel of await tools.findFiles((p) => classifyProjectFile(p) !== undefined)) {
      const kind = classifyProjectFile(rel)!;
      const text = await tools.readFileText(rel).catch(() => '');
      if (text.trim()) found.push(makeFoundFile(kind.source, rel, text, false, kind.settings));
    }
    return [...found, ...(await readUserFiles())];
  }

  /** /import — без аргументов только показывает найденное; с аргументами переносит выбранное в .rules */
  private async importRules(args: string): Promise<void> {
    const { sources, unknown } = parseImportArgs(args);
    if (unknown.length > 0) {
      this.info(`Неизвестные источники: ${unknown.map((u) => `\`${u}\``).join(', ')}. Доступны: ${IMPORT_SOURCES.map((s) => `\`${s.id}\``).join(', ')}, \`all\`.`);
      return;
    }
    // Проверяем до сканирования и вопроса о согласии: иначе send откажет уже после них
    if (sources.length > 0 && this.running.has(this.chat.id)) {
      this.info('Напарник ещё отвечает в этом чате. Дождитесь ответа или остановите его — `/stop`.');
      return;
    }
    // Сканирование только читает файлы локально, доступ к проекту для него не нужен
    const scanner = WorkspaceTools.forCurrentWorkspace(this.preview.confirm);
    if (!scanner) {
      this.info('Откройте папку проекта, чтобы перенести инструкции ИИ-инструментов.');
      return;
    }
    const state = this.workspaceState.get<ImportState>(IMPORT_STATE_KEY, {});
    const all = await this.scanImportSources(scanner);
    if (sources.length === 0) {
      this.info(scanReport(all, state));
      return;
    }

    let found = all.filter((f) => sources.includes(f.source));
    const userFiles = found.filter((f) => f.user && selectForImport([f], state).files.length > 0);
    if (userFiles.length > 0) {
      const answer = await vscode.window.showWarningMessage(
        'Перенести также пользовательские инструкции?',
        {
          modal: true,
          detail:
            `Найдены общие инструкции из домашней папки: ${userFiles.map((f) => f.path).join(', ')}. ` +
            'Их содержимое будет отправлено в сервис 1С:Напарник (code.1c.ai) и перенесено в правила этого проекта.',
        },
        'Перенести',
        'Только проект',
      );
      if (answer === undefined) return;
      if (answer !== 'Перенести') found = found.filter((f) => !f.user);
    }

    const selection = selectForImport(found, state);
    if (selection.files.length === 0) {
      const names = sources.map((id) => IMPORT_SOURCES.find((s) => s.id === id)!.title).join(', ');
      this.info(
        selection.unchanged.length > 0 || selection.tooLarge.length > 0
          ? `Нового для переноса нет (${names}): ${[...selection.unchanged.map((f) => `\`${f.path}\` уже перенесён`), ...selection.tooLarge.map((f) => `\`${f.path}\` слишком большой`)].join(', ')}.`
          : `Инструкций не найдено: ${names}. Что есть в проекте — \`/import\`.`,
      );
      return;
    }
    if (!(await this.ensureProjectAccess('/import'))) return;

    const done = await this.send(`/import ${sources.join(' ')}`, buildImportPrompt(selection, await scanner.readRules()), false, EXPLORE_MAX_STEPS, importDone);
    if (done) {
      // Запоминаем переданные файлы: повторный /import возьмёт только новое и изменившееся
      const next = { ...this.workspaceState.get<ImportState>(IMPORT_STATE_KEY, {}) };
      for (const f of selection.files) next[f.path] = f.hash;
      await this.workspaceState.update(IMPORT_STATE_KEY, next);
    }
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
        this.postEditorContext();
        this.renderCurrentChat();
        this.postProjectState();
        await this.refreshTokenState();
        if (this.pendingMessage) {
          const { text, mode } = this.pendingMessage;
          this.pendingMessage = undefined;
          await this.send(text, undefined, mode);
        }
        break;
      case 'send':
        await this.handleInput(msg.text);
        break;
      case 'stop':
        this.running.get(this.chat.id)?.abort.abort();
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
      case 'toggleEditorContext':
        this.editorContextOff = !this.editorContextOff;
        this.postEditorContext();
        break;
      case 'insertCode':
        await insertIntoEditor(msg.code);
        break;
      case 'mentionQuery': {
        const tools = WorkspaceTools.forCurrentWorkspace(this.preview.confirm);
        const items = tools ? rankPaths(msg.query, await this.mentionPaths(tools)) : [];
        this.post({ type: 'mentionResults', query: msg.query, items });
        break;
      }
    }
  }

  /**
   * Отправить вопрос. text — то, что видит пользователь в чате и истории;
   * modelText — что уходит модели (для /init, /make-rules и /import это развёрнутая инструкция).
   * withEditorContext: true — приложить открытый файл, если пользователь не выключил чип;
   * 'force' — приложить в любом случае (пользователь явно спросил о выделенном).
   * Возвращает true, если модель ответила без ошибок и остановки.
   */
  private async send(
    text: string,
    modelText?: string,
    withEditorContext: boolean | 'force' = false,
    maxSteps = MAX_AGENT_STEPS,
    checkDone?: (executed: AgentCommand[], answerText: string) => string | undefined,
  ): Promise<boolean> {
    text = text.trim();
    // В одном чате — один запрос за раз; в других чатах можно спрашивать параллельно
    if (!text) {
      return false;
    }
    if (this.running.has(this.chat.id)) {
      this.info('Напарник ещё отвечает в этом чате. Дождитесь ответа или остановите его — `/stop`.');
      return false;
    }

    const token = await this.tokens.get();
    if (!token) {
      this.post({ type: 'tokenState', hasToken: false });
      return false;
    }

    // Снимок редактора берём сразу: пока ждём ответа, пользователь может переключить файл
    const useEditor = withEditorContext === 'force' || (withEditorContext && !this.editorContextOff);
    const editorSnap = useEditor ? this.editorContext.snapshot() : undefined;
    // @-упоминания — только в вопросе пользователя, не в развёрнутых инструкциях /init и /import
    const mentioned = modelText === undefined ? await this.resolveMentions(text) : undefined;
    const context = [editorSnap ? contextLabel(editorSnap) : undefined, mentioned?.label].filter(Boolean).join(' · ') || undefined;

    // Запоминаем чат: пользователь может переключиться, а ответ должен попасть сюда
    const chat = this.chat;
    // Состояние дискуссии до запроса: после ошибки или «Стоп» продолжаем от последнего полного ответа
    const before = { lastAssistantUuid: chat.lastAssistantUuid, agentPrimed: chat.agentPrimed, agentPaused: chat.agentPaused, lastEditorContext: chat.lastEditorContext };
    if (chat.entries.length === 0) {
      chat.title = makeTitle(text);
    }
    chat.entries.push({ role: 'user', text, context });
    const run: RunningRequest = { chat, abort: new AbortController(), partial: '' };
    this.running.set(chat.id, run);
    // Сохраняем сразу, чтобы чат появился в истории, пока идёт ответ
    await this.history.save(chat);

    // Сообщения в webview — только если этот чат сейчас на экране
    const postIfVisible = (message: object) => {
      if (this.chat === chat) this.post(message);
    };
    postIfVisible({ type: 'userMessage', text, context });
    postIfVisible({ type: 'assistantStart' });

    try {
      const client = new NaparnikClient({ token, ...readSettings() });
      chat.conversationId ??= await client.createConversation(run.abort.signal);

      const tools = this.projectAccess ? WorkspaceTools.forCurrentWorkspace(this.preview.confirm, run.abort.signal, chat.id, this.preview.confirmOperation)
        : undefined;
      // Контекст редактора — перед вопросом: модель сразу видит, о каком файле и фрагменте речь.
      // Тот же неизменённый файл повторно не шлём — модель уже видела его в этом чате
      let editorBlock = editorSnap ? formatEditorContext(editorSnap) : '';
      // В истории храним хеш, а не сам текст файла — чтобы история чатов не разрасталась
      const editorHash = editorBlock ? createHash('sha1').update(editorBlock).digest('hex') : undefined;
      if (editorHash && editorHash === chat.lastEditorContext) {
        editorBlock = `[Контекст редактора: открыт тот же файл ${editorSnap!.path}, он не изменился с прошлого сообщения]`;
      } else if (editorHash) {
        chat.lastEditorContext = editorHash;
      }
      const question = [editorBlock, mentioned?.block, modelText ?? text].filter(Boolean).join('\n\n');
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
      const answer = await runAgentLoop({
        client,
        conversationId: chat.conversationId,
        parentUuid: chat.lastAssistantUuid,
        message,
        tools,
        maxSteps,
        checkDone,
        signal: run.abort.signal,
        onText: (partial) => {
          run.partial = chat.agentPrimed ? stripCommandsForDisplay(partial) : partial;
          // Модель пишет содержимое файла — вместе с текстом передаём прогресс, чтобы показать его вместо «думает»
          const writing = chat.agentPrimed ? findUnfinishedWrite(partial) : undefined;
          postIfVisible({ type: 'assistantText', text: run.partial, writing });
        },
        onToolCalls: (names) => {
          run.toolNames = names;
          postIfVisible({ type: 'toolCalls', names });
          // Проверка синтаксиса — заметный шаг в чате, а не только статус
          if (names.some((n) => n.endsWith('__validate'))) {
            chat.entries.push({ role: 'step', text: SYNTAX_CHECK_STEP });
            postIfVisible({ type: 'step', text: SYNTAX_CHECK_STEP });
          }
        },
        onRejectedTools: (names) => {
          const description = `⛔ Недоступно вне 1С:EDT: ${names.join(', ')}`;
          chat.entries.push({ role: 'step', text: description });
          postIfVisible({ type: 'step', text: description });
        },
        onStep: (description) => {
          chat.entries.push({ role: 'step', text: description });
          postIfVisible({ type: 'step', text: description });
        },
        onNextRound: () => {
          run.partial = '';
          postIfVisible({ type: 'assistantText', text: '' });
        },
      });
      chat.lastAssistantUuid = answer.assistantUuid;
      chat.entries.push({ role: 'assistant', text: answer.text });
      postIfVisible({ type: 'assistantDone', text: answer.text });
      this.notifyIfHidden(chat);
      return true;
    } catch (err) {
      const message = run.abort.signal.aborted ? 'Остановлено' : errorMessage(err);
      chat.entries.push({ role: 'error', text: message });
      postIfVisible({ type: 'error', message });
      // Дискуссию не сбрасываем: следующий вопрос уйдёт от последнего полного ответа, и модель помнит чат
      // (проверено на живом API — после прерванного ответа и прерванного поиска контекст сохраняется).
      // Неудачная ветка модели не видна, поэтому возвращаем всё, что она могла бы «знать», к состоянию до запроса
      Object.assign(chat, before);
      // Сервер отверг запрос к дискуссии (не токен и не лимит частоты) — она могла испортиться, начинаем новую
      if (err instanceof ApiError && err.status >= 400 && err.status < 500 && ![401, 403, 429].includes(err.status)) {
        Object.assign(chat, { conversationId: undefined, lastAssistantUuid: undefined, agentPrimed: false, agentPaused: false, lastEditorContext: undefined });
      }
      return false;
    } finally {
      this.running.delete(chat.id);
      // Удалённый во время ответа чат обратно в историю не возвращаем
      if (!run.abort.signal.aborted || this.history.list().some((c) => c.id === chat.id)) {
        await this.history.save(chat);
      }
    }
  }

  /** Пути файлов и папок проекта (без игнорируемых git) для @-упоминаний — с кешем, чтобы не обходить проект на каждую букву */
  private mentionPaths(tools: WorkspaceTools): Promise<string[]> {
    const root = tools.rootUri.toString();
    const cached = this.mentionIndex;
    if (cached && cached.root === root && Date.now() - cached.at < MENTION_INDEX_TTL_MS) return cached.paths;
    const paths = tools
      .findFiles(() => true, MAX_MENTION_INDEX_FILES)
      .then(withFolders)
      .catch(() => []);
    this.mentionIndex = { root, at: Date.now(), paths };
    return paths;
  }

  /** Файлы и папки, упомянутые в вопросе через @, — блок для модели и подпись под сообщением */
  private async resolveMentions(text: string): Promise<{ block: string; label: string } | undefined> {
    const tokens = findMentions(text);
    const tools = tokens.length > 0 ? WorkspaceTools.forCurrentWorkspace(this.preview.confirm) : undefined;
    if (!tools) return undefined;
    const paths = await this.mentionPaths(tools);
    const files: { path: string; text: string }[] = [];
    const notRead: string[] = [];
    const notes: string[] = [];
    const fileMentions: { token: string; path: string }[] = [];
    const folderMentions: { token: string; path: string }[] = [];
    for (const token of tokens) {
      const found = resolveMention(token, paths);
      if (found && 'path' in found) (found.path.endsWith('/') ? folderMentions : fileMentions).push({ token, path: found.path });
      else if (found) {
        notes.push(`\`@${token}\` — подходит к ${found.candidates.length} путям, уточните путь (подсказка появляется при вводе @)`);
      } else if (/[./]/.test(token)) {
        // «@Клиент» может быть просто словом, а «@a.bsl» — явно файл
        notes.push(`\`@${token}\` — файл или папка не найдены`);
      }
    }
    // Явно упомянутые файлы важнее файлов папок — они первыми, папкам остаётся остаток лимита
    for (const { token, path } of fileMentions) {
      if (files.some((f) => f.path === path)) continue;
      const content = await tools.readFileText(path).catch(() => undefined);
      if (content === undefined) notes.push(`\`@${token}\` — не удалось прочитать (двоичный файл?)`);
      else files.push({ path, text: content });
    }
    const used = files.reduce((sum, f) => sum + Math.min(f.text.length, MAX_MENTION_FILE_CHARS), 0);
    const folderContents = new Map<string, string[]>();
    const candidates: { path: string; text: string }[] = [];
    // Папки могут пересекаться («@src/» и «@src/cf/») — один файл берём один раз; Set — в папке бывают десятки тысяч файлов
    const seen = new Set(files.map((f) => f.path));
    let reads = 0;
    for (const { token, path: folder } of folderMentions) {
      const inside = folderFiles(folder, paths);
      folderContents.set(folder, inside);
      if (inside.length === 0) notes.push(`\`@${token}\` — в папке нет файлов`);
      let binary = 0;
      for (const path of inside) {
        if (seen.has(path)) continue;
        seen.add(path);
        if (reads >= MAX_FOLDER_FILES_READ) {
          notRead.push(path);
          continue;
        }
        reads++;
        const content = await tools.readFileText(path).catch(() => undefined);
        if (content === undefined) binary++;
        else candidates.push({ path, text: content });
      }
      if (binary) notes.push(`\`@${token}\` — пропущено двоичных файлов: ${binary}`);
    }
    const { picked, skipped: notFit } = pickFolderFiles(candidates, MAX_MENTION_TOTAL_CHARS - used);
    files.push(...picked);
    notRead.unshift(...notFit);
    const { text: block, skipped } = formatMentionedFiles(files, notRead);
    if (skipped.length) {
      notes.push(`не приложены из-за объёма (${skipped.length}): ${shortList(skipped.map((p) => `\`${p}\``), 10)}`);
    }
    if (notes.length) this.info(`Упоминания: ${notes.join('; ')}.`);
    if (!block) return undefined;
    const notAttached = new Set(skipped);
    const shownPaths = new Set(files.map((f) => f.path).filter((p) => !notAttached.has(p)));
    const attached = (path: string) => shownPaths.has(path);
    const labels = [
      ...fileMentions.filter((m) => attached(m.path)).map((m) => '@' + m.path.split('/').pop()),
      ...folderMentions
        .filter((m) => folderContents.get(m.path)!.some(attached))
        .map((m) => '@' + m.path.slice(0, -1).split('/').pop() + '/'),
    ];
    return { block, label: [...new Set(labels)].join(', ') };
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
      <button type="button" id="editor-chip" class="chip hidden" title=""></button>
      <button type="button" id="project-toggle" class="toggle" title="Разрешить Напарнику смотреть и читать файлы открытого проекта">
        <span class="toggle-dot"></span>Доступ к проекту
      </button>
    </div>
    <div id="slash-menu" class="slash-menu hidden" role="listbox"></div>
    <textarea id="input" rows="3" placeholder="Задай мне вопрос… «/» — команды, «@» — файл или папка проекта&#10;Enter — отправить, Shift+Enter — новая строка"></textarea>
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

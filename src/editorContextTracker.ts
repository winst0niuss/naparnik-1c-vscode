import * as vscode from 'vscode';
import { EditorDiagnostic, EditorSnapshot, contextLabel } from './agent/editorContext';

/**
 * Следит за последним текстовым редактором пользователя.
 * Когда фокус уходит в панель чата, активный редактор не меняется — поэтому контекст остаётся доступным.
 */
export class EditorContextTracker implements vscode.Disposable {
  private editor: vscode.TextEditor | undefined;
  private readonly emitter = new vscode.EventEmitter<void>();
  // Выделение меняется на каждое движение курсора и нажатие клавиши — сообщаем не чаще раза в 150 мс
  private selectionTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly subscriptions: vscode.Disposable[];

  /** Сменился файл или выделение */
  readonly onDidChange = this.emitter.event;

  constructor() {
    this.editor = supported(vscode.window.activeTextEditor) ? vscode.window.activeTextEditor : undefined;
    this.subscriptions = [
      this.emitter,
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (supported(editor)) {
          this.set(editor);
        } else if (this.editor && !vscode.window.visibleTextEditors.includes(this.editor)) {
          // Редактор закрыли — контекста больше нет. Если он просто потерял фокус (например, ушли в Output) — оставляем
          this.set(undefined);
        }
      }),
      vscode.window.onDidChangeVisibleTextEditors((editors) => {
        if (this.editor && !editors.includes(this.editor)) this.set(undefined);
      }),
      vscode.window.onDidChangeTextEditorSelection(({ textEditor }) => {
        if (textEditor !== this.editor) return;
        clearTimeout(this.selectionTimer);
        this.selectionTimer = setTimeout(() => this.emitter.fire(), 150);
      }),
    ];
  }

  get uri(): vscode.Uri | undefined {
    return this.editor?.document.uri;
  }

  /** Подпись для чипа — без чтения текста файла и ошибок (вызывается часто) */
  describe(): { label: string; path: string } | undefined {
    const editor = this.editor;
    if (!editor || editor.document.isClosed) return undefined;
    const path = this.pathOf(editor.document);
    const selection = this.selectionLines(editor);
    // Для подписи текст не нужен — передаём пустые поля
    const label = contextLabel({ path, inWorkspace: false, languageId: '', lineCount: 0, fullText: '', diagnostics: [], selection: selection && { ...selection, text: '' } });
    return { label, path };
  }

  /** Снимок для отправки: файл, выделение, текст, ошибки. undefined — открытого файла нет */
  snapshot(): EditorSnapshot | undefined {
    const editor = this.editor;
    if (!editor || editor.document.isClosed) return undefined;
    const doc = editor.document;
    const folder = vscode.workspace.getWorkspaceFolder(doc.uri);
    const path = this.pathOf(doc);
    const lines = this.selectionLines(editor);
    const selection = lines && { ...lines, text: doc.getText(editor.selection) };

    const diagnostics: EditorDiagnostic[] = vscode.languages
      .getDiagnostics(doc.uri)
      .filter((d) => d.severity === vscode.DiagnosticSeverity.Error || d.severity === vscode.DiagnosticSeverity.Warning)
      .map((d) => ({
        line: d.range.start.line + 1,
        severity: d.severity === vscode.DiagnosticSeverity.Error ? 'ошибка' : 'предупреждение',
        message: d.message.split('\n')[0],
      }));

    return {
      path,
      inWorkspace: Boolean(folder),
      languageId: doc.languageId,
      lineCount: doc.lineCount,
      selection,
      fullText: doc.getText(),
      diagnostics,
    };
  }

  private pathOf(doc: vscode.TextDocument): string {
    if (doc.uri.scheme === 'untitled') return 'несохранённый файл';
    return vscode.workspace.getWorkspaceFolder(doc.uri) ? vscode.workspace.asRelativePath(doc.uri, false) : doc.uri.fsPath;
  }

  /** Номера выделенных строк (с 1); пустое выделение — undefined */
  private selectionLines(editor: vscode.TextEditor): { startLine: number; endLine: number } | undefined {
    const sel = editor.selection;
    if (sel.isEmpty) return undefined;
    // Выделение до начала следующей строки (тройной клик) — последней строкой считаем предыдущую
    const endLine = sel.end.character === 0 && sel.end.line > sel.start.line ? sel.end.line : sel.end.line + 1;
    return { startLine: sel.start.line + 1, endLine };
  }

  private set(editor: vscode.TextEditor | undefined): void {
    this.editor = editor;
    this.emitter.fire();
  }

  dispose(): void {
    clearTimeout(this.selectionTimer);
    this.subscriptions.forEach((s) => s.dispose());
  }
}

/** Обычный файл или несохранённый документ; служебные документы (Output, diff Напарника, git) — нет */
export function supported(editor: vscode.TextEditor | undefined): boolean {
  if (!editor) return false;
  const uri = editor.document.uri;
  return uri.scheme === 'file' || uri.scheme === 'untitled';
}

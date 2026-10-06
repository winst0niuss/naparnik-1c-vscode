import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { TokenStore } from './tokenStore';
import { findTokenProblem } from './api/client';
import { ChatHistory } from './chatHistory';
import { EditPreview } from './agent/editPreview';
import { EditorContextTracker, supported } from './editorContextTracker';

export function activate(context: vscode.ExtensionContext): void {
  const tokens = new TokenStore(context.secrets);
  const preview = new EditPreview();
  const editorContext = new EditorContextTracker();
  const chat = new ChatViewProvider(
    context.extensionUri,
    tokens,
    new ChatHistory(context.globalState),
    context.workspaceState,
    context.globalState,
    preview,
    editorContext,
  );

  context.subscriptions.push(
    preview.register(),
    editorContext,
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      // Не терять переписку и идущий стрим при переключении панелей
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('naparnik.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('naparnik.showHistory', () => chat.showHistory()),
    vscode.commands.registerCommand('naparnik.toggleProjectAccess', () => chat.toggleProjectAccess()),
    // Кнопки ✓/✕ в заголовке вкладки с diff предложенной правки
    vscode.commands.registerCommand('naparnik.applyEdit', (uri?: vscode.Uri) => preview.resolveByUri(uri ?? activeDiffUri(), true)),
    vscode.commands.registerCommand('naparnik.rejectEdit', (uri?: vscode.Uri) => preview.resolveByUri(uri ?? activeDiffUri(), false)),

    vscode.commands.registerCommand('naparnik.setToken', async () => {
      const token = await vscode.window.showInputBox({
        title: '1С:Напарник — API-токен',
        prompt: 'Токен из личного кабинета code.1c.ai',
        password: true,
        ignoreFocusOut: true,
        // Проверка прямо в поле ввода: неверный токен нельзя сохранить
        validateInput: (value) => (value.trim() ? findTokenProblem(value.trim()) : undefined),
      });
      if (token?.trim()) {
        await tokens.set(token.trim());
        void vscode.window.showInformationMessage('Токен 1С:Напарник сохранён.');
      }
    }),

    vscode.commands.registerCommand('naparnik.clearToken', async () => {
      await tokens.clear();
      void vscode.window.showInformationMessage('Токен 1С:Напарник удалён.');
    }),

    vscode.commands.registerCommand('naparnik.askAboutSelection', async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.selection.isEmpty) {
        return;
      }
      const question = await vscode.window.showInputBox({
        title: 'Что сделать с кодом?',
        value: 'Объясни этот код',
      });
      if (!question?.trim()) {
        return;
      }
      if (supported(editor)) {
        // Обычный файл: выделение уйдёт как контекст редактора — с путём и номерами строк
        await chat.ask(question);
      } else {
        // Служебная вкладка (Output, diff…) — контекста редактора у неё нет, вставляем код в вопрос
        const code = editor.document.getText(editor.selection);
        await chat.ask(`${question}\n\n\`\`\`\n${code}\n\`\`\``, false);
      }
    }),

    tokens.onDidChange(() => chat.refreshTokenState()),
  );
}

/** Правая сторона активного diff — на случай вызова команды из палитры */
function activeDiffUri(): vscode.Uri | undefined {
  const input = vscode.window.tabGroups.activeTabGroup.activeTab?.input;
  return input instanceof vscode.TabInputTextDiff ? input.modified : undefined;
}

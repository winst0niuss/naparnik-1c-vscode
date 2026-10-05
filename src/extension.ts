import * as vscode from 'vscode';
import { ChatViewProvider } from './chatViewProvider';
import { TokenStore } from './tokenStore';
import { findTokenProblem } from './api/client';
import { ChatHistory } from './chatHistory';

export function activate(context: vscode.ExtensionContext): void {
  const tokens = new TokenStore(context.secrets);
  const chat = new ChatViewProvider(context.extensionUri, tokens, new ChatHistory(context.globalState));

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(ChatViewProvider.viewId, chat, {
      // Не терять переписку и идущий стрим при переключении панелей
      webviewOptions: { retainContextWhenHidden: true },
    }),

    vscode.commands.registerCommand('naparnik.newChat', () => chat.newChat()),
    vscode.commands.registerCommand('naparnik.showHistory', () => chat.showHistory()),

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
      const code = editor?.document.getText(editor.selection).trim();
      if (!code) {
        return;
      }
      const question = await vscode.window.showInputBox({
        title: 'Что сделать с кодом?',
        value: 'Объясни этот код',
      });
      if (question === undefined) {
        return;
      }
      await chat.ask(`${question}\n\n\`\`\`bsl\n${code}\n\`\`\``);
    }),

    tokens.onDidChange(() => chat.refreshTokenState()),
  );
}

export function deactivate(): void {}

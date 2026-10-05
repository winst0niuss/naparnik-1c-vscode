import * as vscode from 'vscode';
import * as path from 'node:path';

export const PROPOSED_SCHEME = 'naparnik-proposed';

export interface PendingEdit {
  id: number;
  /** Путь относительно проекта — для карточки в чате */
  label: string;
  isNew: boolean;
}

/**
 * Показ предложенной правки как diff и ожидание решения пользователя.
 * Решить можно тремя способами: карточка в чате, кнопки ✓/✕ в заголовке diff, уведомление.
 * Предложенный текст отдаётся через виртуальный документ — на диск ничего не пишется до «Применить».
 */
export class EditPreview implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly decisions = new Map<number, (accepted: boolean) => void>();
  private counter = 0;

  private readonly startEmitter = new vscode.EventEmitter<PendingEdit>();
  private readonly endEmitter = new vscode.EventEmitter<{ id: number; accepted: boolean }>();
  /** Появилась правка, ожидающая решения */
  readonly onDidStart = this.startEmitter.event;
  /** Пользователь принял решение */
  readonly onDidEnd = this.endEmitter.event;

  register(): vscode.Disposable {
    return vscode.Disposable.from(
      vscode.workspace.registerTextDocumentContentProvider(PROPOSED_SCHEME, this),
      this.startEmitter,
      this.endEmitter,
    );
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  /** Решение из чата или по кнопке в заголовке diff */
  resolve(id: number, accepted: boolean): void {
    this.decisions.get(id)?.(accepted);
  }

  /** Кнопки ✓/✕ в заголовке diff передают Uri правой стороны: /<id>/proposed/<имя> */
  resolveByUri(uri: vscode.Uri | undefined, accepted: boolean): void {
    const id = Number(uri?.path.split('/')[1]);
    if (id) this.resolve(id, accepted);
  }

  confirm = async (target: vscode.Uri, original: string, proposed: string, isNew: boolean, signal?: AbortSignal): Promise<boolean> => {
    const name = path.basename(target.fsPath);
    const label = vscode.workspace.asRelativePath(target);
    // Уникальный id: одну и ту же правку модель может прислать несколько раз
    const id = ++this.counter;
    const left = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${id}/original/${name}` });
    const right = vscode.Uri.from({ scheme: PROPOSED_SCHEME, path: `/${id}/proposed/${name}` });
    this.contents.set(left.toString(), original);
    this.contents.set(right.toString(), proposed);

    const decision = new Promise<boolean>((resolve) => this.decisions.set(id, resolve));
    // Без решения ожидание вечное: «Стоп» в чате и закрытие вкладки diff считаем отказом
    const onAbort = () => this.resolve(id, false);
    signal?.addEventListener('abort', onAbort);
    const tabWatcher = vscode.window.tabGroups.onDidChangeTabs(({ closed }) => {
      if (closed.some((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === right.toString())) {
        this.resolve(id, false);
      }
    });
    try {
      if (signal?.aborted) return false;
      const title = isNew ? `Напарник: новый файл ${name}` : `Напарник: правка ${name}`;
      await vscode.commands.executeCommand('vscode.diff', left, right, title, { preview: true });
      this.startEmitter.fire({ id, label, isNew });

      // Уведомление — дополнительный способ ответить; его могут скрыть, поэтому не ждём только его
      void vscode.window
        .showInformationMessage(isNew ? `Напарник предлагает создать ${label}` : `Напарник предлагает изменить ${label}`, 'Применить', 'Отклонить')
        .then((choice) => {
          if (choice) this.resolve(id, choice === 'Применить');
        });

      const accepted = await decision;
      this.endEmitter.fire({ id, accepted });
      return accepted;
    } finally {
      signal?.removeEventListener('abort', onAbort);
      tabWatcher.dispose();
      this.decisions.delete(id);
      await closeTabsFor(right);
      this.contents.delete(left.toString());
      this.contents.delete(right.toString());
    }
  };
}

async function closeTabsFor(uri: vscode.Uri): Promise<void> {
  const tabs = vscode.window.tabGroups.all
    .flatMap((g) => g.tabs)
    .filter((t) => t.input instanceof vscode.TabInputTextDiff && t.input.modified.toString() === uri.toString());
  if (tabs.length > 0) {
    await vscode.window.tabGroups.close(tabs);
  }
}

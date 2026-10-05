import * as vscode from 'vscode';

const SECRET_KEY = 'naparnik.token';

/** Токен хранится в SecretStorage (связка ключей ОС), а не в settings.json */
export class TokenStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  get(): Thenable<string | undefined> {
    return this.secrets.get(SECRET_KEY);
  }

  set(token: string): Thenable<void> {
    return this.secrets.store(SECRET_KEY, token);
  }

  clear(): Thenable<void> {
    return this.secrets.delete(SECRET_KEY);
  }

  get onDidChange(): vscode.Event<vscode.SecretStorageChangeEvent> {
    return this.secrets.onDidChange;
  }
}

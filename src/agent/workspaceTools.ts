import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { AgentCommand, ProjectContext, applySearchReplace } from './protocol';
import { PROJECT_DOC_DIRS, PROJECT_DOC_FILES, RULES_DIR } from '../slashCommands';
import { SECRET_FILE } from './editorContext';

const MAX_FILE_CHARS = 60_000;
// Документация прикладывается к первому сообщению, только если она короткая
const MAX_ATTACHED_DOC_CHARS = 4_000;
const MAX_ATTACHED_TOTAL_CHARS = 12_000;
const MAX_RULES_TOTAL_CHARS = 12_000;
const MAX_DIR_ENTRIES = 200;
const MAX_SEARCH_RESULTS = 50;
const MAX_SEARCH_FILES = 5_000;
// Большие файлы (выгрузки XML, логи) при поиске пропускаем — иначе поиск идёт минутами
const MAX_SEARCH_FILE_BYTES = 1_000_000;
const IGNORED_DIRS = new Set(['.git', 'node_modules', 'out', 'dist', '.vscode-test']);

/** Решение пользователя по предложенной правке. signal — запрос остановили, ждать решения больше не нужно */
export type ConfirmEdit = (
  uri: vscode.Uri,
  original: string,
  proposed: string,
  isNew: boolean,
  signal?: AbortSignal,
  owner?: string,
) => Promise<boolean>;

/**
 * Выполнение команд Напарника в открытой папке.
 * Все пути проверяются: выйти за пределы корня проекта нельзя.
 */
export class WorkspaceTools {
  constructor(
    private readonly root: vscode.Uri,
    private readonly confirmEdit: ConfirmEdit,
    private readonly signal?: AbortSignal,
    // id чата — к нему привязываются карточки правок
    private readonly owner?: string,
  ) {}

  static forCurrentWorkspace(confirmEdit: ConfirmEdit, signal?: AbortSignal, owner?: string): WorkspaceTools | undefined {
    const folder = vscode.workspace.workspaceFolders?.[0];
    return folder ? new WorkspaceTools(folder.uri, confirmEdit, signal, owner) : undefined;
  }

  /** Выполнить команду и вернуть текст результата для модели (ошибки — тоже текстом) */
  async run(cmd: AgentCommand): Promise<string> {
    try {
      switch (cmd.kind) {
        case 'list_dir':
          return await this.listDir(cmd.path);
        case 'read_file':
          return await this.readFile(cmd.path);
        case 'search':
          return await this.search(cmd.query, cmd.glob);
        case 'edit_file':
          return await this.editFile(cmd.path, cmd.edits);
        case 'create_file':
          return await this.createFile(cmd.path, cmd.content);
      }
    } catch (err) {
      return `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Дерево проекта для первого сообщения: небольшой проект — целиком (модели не нужно ходить по папкам),
   * большой (например, выгрузка конфигурации) — только два верхних уровня.
   */
  async tree(): Promise<{ text: string; complete: boolean }> {
    const full = await this.buildTree(8, 200);
    return full.truncated ? { text: (await this.buildTree(2, 150)).text, complete: false } : { text: full.text, complete: true };
  }

  private async buildTree(depth: number, maxLines: number): Promise<{ text: string; truncated: boolean }> {
    let truncated = false;
    const lines: string[] = [];
    const walk = async (uri: vscode.Uri, level: number) => {
      if (lines.length >= maxLines) return;
      const entries = await this.sortedEntries(uri);
      for (const [name, type] of entries) {
        if (lines.length >= maxLines) {
          lines.push('  '.repeat(level) + '…');
          truncated = true;
          return;
        }
        const isDir = type === vscode.FileType.Directory;
        lines.push('  '.repeat(level) + name + (isDir ? '/' : ''));
        if (isDir && level + 1 < depth) {
          await walk(vscode.Uri.joinPath(uri, name), level + 1);
        }
      }
    };
    await walk(this.root, 0);
    return { text: lines.join('\n') || '(папка пуста)', truncated };
  }

  /** Документация, инструкции ИИ-инструментов и правила из .rules — для первого сообщения */
  async projectContext(): Promise<ProjectContext> {
    const docs: string[] = [];
    for (const rel of PROJECT_DOC_FILES) {
      if (await this.exists(vscode.Uri.joinPath(this.root, rel))) docs.push(rel);
    }
    for (const dir of PROJECT_DOC_DIRS) {
      docs.push(...(await this.markdownFilesIn(dir, 20)));
    }

    // NAPARNIK.md — описание, созданное /init, прикладываем всегда (обрезая), остальное — если короткое
    const attached: { path: string; text: string }[] = [];
    let total = 0;
    for (const rel of docs) {
      const text = await this.readText(vscode.Uri.joinPath(this.root, rel)).catch(() => '');
      const limit = rel === 'NAPARNIK.md' ? MAX_ATTACHED_TOTAL_CHARS : MAX_ATTACHED_DOC_CHARS;
      if (!text || (text.length > limit && rel !== 'NAPARNIK.md') || total + Math.min(text.length, limit) > MAX_ATTACHED_TOTAL_CHARS) continue;
      attached.push({ path: rel, text: text.slice(0, limit) });
      total += Math.min(text.length, limit);
    }

    const rules: { path: string; text: string }[] = [];
    let rulesTotal = 0;
    for (const rel of await this.markdownFilesIn(RULES_DIR, 50)) {
      const text = await this.readText(vscode.Uri.joinPath(this.root, rel)).catch(() => '');
      if (!text.trim()) continue;
      const part = text.slice(0, MAX_RULES_TOTAL_CHARS - rulesTotal);
      if (!part) break;
      rules.push({ path: rel, text: part });
      rulesTotal += part.length;
    }
    return { docs, attached, rules };
  }

  /** Список файлов правил .rules/*.md (для /rules) */
  async ruleFiles(): Promise<vscode.Uri[]> {
    return (await this.markdownFilesIn(RULES_DIR, 50)).map((rel) => vscode.Uri.joinPath(this.root, rel));
  }

  get rootUri(): vscode.Uri {
    return this.root;
  }

  /** .md/.mdc/.txt в папке (до 2 уровней вложенности) */
  private async markdownFilesIn(dir: string, limit: number): Promise<string[]> {
    const found: string[] = [];
    const walk = async (rel: string, level: number) => {
      let entries: [string, vscode.FileType][];
      try {
        entries = await this.sortedEntries(vscode.Uri.joinPath(this.root, rel));
      } catch {
        return; // папки нет
      }
      for (const [name, type] of entries) {
        if (found.length >= limit) return;
        const child = `${rel}/${name}`;
        if (type === vscode.FileType.Directory && level < 2) await walk(child, level + 1);
        else if (type === vscode.FileType.File && /\.(md|mdc|txt)$/i.test(name)) found.push(child);
      }
    };
    await walk(dir, 0);
    return found;
  }

  private async listDir(relPath: string): Promise<string> {
    const uri = await this.resolve(relPath);
    const entries = await this.sortedEntries(uri);
    const shown = entries.slice(0, MAX_DIR_ENTRIES).map(([name, type]) => name + (type === vscode.FileType.Directory ? '/' : ''));
    const more = entries.length > MAX_DIR_ENTRIES ? `\n… ещё ${entries.length - MAX_DIR_ENTRIES}` : '';
    return `Содержимое ${relPath}:\n${shown.join('\n') || '(пусто)'}${more}`;
  }

  private async readFile(relPath: string): Promise<string> {
    const uri = await this.resolve(relPath);
    if (SECRET_FILE.test(this.relative(uri))) {
      throw new Error(`${relPath} может содержать секреты — чтение запрещено`);
    }
    const text = await this.readText(uri);
    if (text.length > MAX_FILE_CHARS) {
      return `Файл ${relPath} (показаны первые ${MAX_FILE_CHARS} символов из ${text.length}):\n${text.slice(0, MAX_FILE_CHARS)}`;
    }
    return `Файл ${relPath}:\n${text}`;
  }

  private async search(query: string, glob?: string): Promise<string> {
    const files = await vscode.workspace.findFiles(
      new vscode.RelativePattern(this.root, glob || '**/*'),
      `**/{${[...IGNORED_DIRS].join(',')}}/**`,
      MAX_SEARCH_FILES,
    );
    const needle = query.toLowerCase();
    const results: string[] = [];

    for (const file of files) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      // Совпадение в пути: ищут часто по имени объекта, а не по тексту
      const rel = this.relative(file);
      if (rel.toLowerCase().includes(needle)) {
        results.push(`${rel} (совпадение в пути)`);
      }
      if (SECRET_FILE.test(rel)) continue;
      let text: string;
      try {
        if ((await vscode.workspace.fs.stat(file)).size > MAX_SEARCH_FILE_BYTES) continue;
        text = await this.readText(file);
      } catch {
        continue; // бинарный или нечитаемый файл
      }
      const lines = text.split(/\r?\n/);
      for (let i = 0; i < lines.length && results.length < MAX_SEARCH_RESULTS; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          results.push(`${this.relative(file)}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
        }
      }
    }

    if (results.length === 0) {
      return `По запросу «${query}» ничего не найдено.`;
    }
    const limit = results.length >= MAX_SEARCH_RESULTS ? `\n(показаны первые ${MAX_SEARCH_RESULTS} совпадений)` : '';
    return `Найдено по запросу «${query}»:\n${results.join('\n')}${limit}`;
  }

  private async editFile(relPath: string, edits: { search: string; replace: string }[]): Promise<string> {
    const uri = await this.resolve(relPath);
    const original = await this.readText(uri);
    const proposed = applySearchReplace(original, edits);
    if (!(await this.confirmEdit(uri, original, proposed, false, this.signal, this.owner))) {
      return `Пользователь отклонил правку ${relPath}.`;
    }
    // Пока пользователь смотрел diff, файл могли изменить — не затираем эти изменения
    if ((await this.readText(uri)) !== original) {
      return `Правка ${relPath} не применена: файл изменился, пока пользователь смотрел diff. Перечитай файл и предложи правку заново.`;
    }
    await this.write(uri, proposed);
    return `Правка ${relPath} применена.`;
  }

  private async createFile(relPath: string, content: string): Promise<string> {
    const uri = await this.resolve(relPath);
    if (await this.exists(uri)) {
      return `Ошибка: файл ${relPath} уже существует. Для изменения используй edit_file.`;
    }
    if (!(await this.confirmEdit(uri, '', content, true, this.signal, this.owner))) {
      return `Пользователь отклонил создание ${relPath}.`;
    }
    if (await this.exists(uri)) {
      return `Файл ${relPath} не создан: он появился, пока пользователь смотрел diff.`;
    }
    await this.write(uri, content);
    return `Файл ${relPath} создан.`;
  }

  /**
   * Путь от модели → Uri внутри проекта. Попытка выйти наружу — ошибка.
   * Проверяется и реальный путь: символическая ссылка внутри проекта не должна вести за его пределы.
   */
  private async resolve(relPath: string): Promise<vscode.Uri> {
    const clean = relPath.replace(/\\/g, '/').replace(/^\/+/, '');
    const full = path.resolve(this.root.fsPath, clean);
    const rootReal = await realpath(this.root.fsPath);
    if (!isInside(this.root.fsPath, full) || !isInside(rootReal, await realpathOfExisting(full))) {
      throw new Error(`путь ${relPath} вне проекта`);
    }
    return vscode.Uri.file(full);
  }

  private relative(uri: vscode.Uri): string {
    return path.relative(this.root.fsPath, uri.fsPath).split(path.sep).join('/');
  }

  private async sortedEntries(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    return entries
      .filter(([name]) => !IGNORED_DIRS.has(name))
      .sort(([a, ta], [b, tb]) => (ta === tb ? a.localeCompare(b) : ta === vscode.FileType.Directory ? -1 : 1));
  }

  private async readText(uri: vscode.Uri): Promise<string> {
    // Открытый файл читаем из редактора — с несохранёнными изменениями пользователя
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      return open.getText();
    }
    const bytes = await vscode.workspace.fs.readFile(uri);
    if (bytes.subarray(0, 8000).includes(0)) {
      throw new Error(`${this.relative(uri)} — бинарный файл`);
    }
    // Модули 1С обычно в UTF-8 с BOM — BOM модели не нужен
    return new TextDecoder('utf-8').decode(bytes).replace(/^\uFEFF/, '');
  }

  private async write(uri: vscode.Uri, text: string): Promise<void> {
    // Если файл открыт в редакторе — правим через редактор, чтобы не было конфликта с несохранёнными изменениями
    const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (open) {
      const edit = new vscode.WorkspaceEdit();
      edit.replace(uri, new vscode.Range(0, 0, open.lineCount, 0), text);
      if (!(await vscode.workspace.applyEdit(edit))) {
        throw new Error('VS Code не применил правку к открытому файлу');
      }
      await open.save();
      return;
    }
    // Сохраняем BOM, если он был в исходном файле
    let bom = false;
    if (await this.exists(uri)) {
      const old = await vscode.workspace.fs.readFile(uri);
      bom = old[0] === 0xef && old[1] === 0xbb && old[2] === 0xbf;
    }
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode((bom ? '\uFEFF' : '') + text));
  }

  private async exists(uri: vscode.Uri): Promise<boolean> {
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }
}

function isInside(root: string, target: string): boolean {
  return target === root || target.startsWith(root + path.sep);
}

/** Реальный путь существующей части: для нового файла проверяем ближайшую существующую папку */
async function realpathOfExisting(target: string): Promise<string> {
  let current = target;
  const rest: string[] = [];
  for (;;) {
    try {
      return path.join(await realpath(current), ...rest);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.unshift(path.basename(current));
      current = parent;
    }
  }
}

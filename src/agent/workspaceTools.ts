import * as vscode from 'vscode';
import * as path from 'node:path';
import { realpath } from 'node:fs/promises';
import { AgentCommand, ProjectContext, applySearchReplace } from './protocol';
import { PROJECT_DOC_DIRS, PROJECT_DOC_FILES, RULES_DIR } from '../slashCommands';
import { globToRegExp, parseGitignore } from './gitignore';

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
const TREE_MAX_LINES = 250;
const TREE_MAX_DEPTH = 4;
const TREE_FULL_DEPTH = 12;

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
          return await this.listDir(cmd.path, cmd.depth);
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
      // Понятное модели сообщение вместо «EntryNotFound (FileSystemError)…»
      if (err instanceof vscode.FileSystemError && err.code === 'FileNotFound') {
        return `Ошибка: не найдено — ${'path' in cmd ? cmd.path : ''}. Сверься с картой проекта или найди через @search.`;
      }
      return `Ошибка: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  /**
   * Карта проекта для первого сообщения.
   * Небольшой проект — целиком (модули форм 1С лежат на 6–7 уровнях). Большой — самое глубокое дерево
   * до 4 уровней, которое помещается в лимит строк; в больших папках — первые элементы и «… ещё N».
   * Так видны все папки верхнего уровня, а не только первая большая, съевшая весь бюджет строк.
   */
  async tree(): Promise<{ text: string; complete: boolean }> {
    const full = await this.buildTree(this.root, TREE_FULL_DEPTH, TREE_MAX_LINES, false);
    if (!full.overflow) return { text: full.text, complete: !full.truncated };
    for (const depth of [TREE_MAX_DEPTH, 3, 2]) {
      const result = await this.buildTree(this.root, depth, TREE_MAX_LINES);
      if (!result.overflow) return { text: result.text, complete: false };
    }
    const { text } = await this.buildTree(this.root, 1, Infinity);
    return { text, complete: false };
  }

  /**
   * overflow — дерево не поместилось в maxLines (обход прерван); truncated — что-то свёрнуто в «… ещё N».
   * limitPerDir — показывать в больших папках только первые элементы (для сокращённой карты).
   */
  private async buildTree(
    start: vscode.Uri,
    depth: number,
    maxLines: number,
    limitPerDir = true,
  ): Promise<{ text: string; truncated: boolean; overflow: boolean }> {
    let truncated = false;
    let overflow = false;
    const lines: string[] = [];
    // Корень показываем шире, вложенные папки — первыми элементами: однотипные объекты 1С понятны по нескольким
    const perDir = (level: number) => (!limitPerDir ? Infinity : level === 0 ? 60 : level === 1 ? 25 : 12);
    const walk = async (uri: vscode.Uri, level: number) => {
      const entries = await this.sortedEntries(uri);
      for (let i = 0; i < entries.length; i++) {
        if (lines.length >= maxLines) {
          overflow = true;
          return;
        }
        const indent = '  '.repeat(level);
        if (i >= perDir(level)) {
          const dirs = entries.slice(i).filter(([, t]) => t === vscode.FileType.Directory).length;
          lines.push(`${indent}… ещё ${entries.length - i} (папок: ${dirs})`);
          truncated = true;
          return;
        }
        const [name, type] = entries[i];
        const isDir = type === vscode.FileType.Directory;
        lines.push(indent + name + (isDir ? '/' : ''));
        if (isDir && level + 1 < depth) {
          await walk(vscode.Uri.joinPath(uri, name), level + 1);
        } else if (isDir) {
          truncated = true; // глубже не смотрели
        }
      }
    };
    await walk(start, 0);
    return { text: lines.join('\n') || '(папка пуста)', truncated: truncated || overflow, overflow };
  }

  /**
   * Файлы проекта для поиска. Обходим папки сами, не заходя в игнорируемые: иначе большая папка
   * из .gitignore (зависимости, сборка) съела бы лимит файлов раньше, чем дойдёт очередь до кода.
   */
  private async collectFiles(match: RegExp | undefined, limit: number): Promise<vscode.Uri[]> {
    const files: vscode.Uri[] = [];
    const queue: vscode.Uri[] = [this.root];
    while (queue.length > 0 && files.length < limit) {
      const dir = queue.shift()!;
      for (const [name, type] of await this.sortedEntries(dir)) {
        const uri = vscode.Uri.joinPath(dir, name);
        if (type & vscode.FileType.Directory) queue.push(uri);
        else if (!match || match.test(this.relative(uri))) files.push(uri);
        if (files.length >= limit) break;
      }
    }
    return files;
  }

  /** Документация, инструкции ИИ-инструментов и правила из .rules — для первого сообщения */
  async projectContext(): Promise<ProjectContext> {
    const docs: string[] = [];
    // Корень и папки первого уровня: в папке может лежать несколько проектов со своими README/CLAUDE.md
    const bases = ['', ...(await this.sortedEntries(this.root)).filter(([, t]) => t === vscode.FileType.Directory).map(([n]) => n + '/')];
    for (const base of bases) {
      for (const rel of PROJECT_DOC_FILES) {
        if (await this.exists(vscode.Uri.joinPath(this.root, base + rel))) docs.push(base + rel);
      }
    }
    for (const dir of PROJECT_DOC_DIRS) {
      docs.push(...(await this.markdownFilesIn(dir, 20)));
    }

    // NAPARNIK.md — описание, созданное /init, прикладываем всегда (обрезая), остальное — если короткое
    const attached: { path: string; text: string }[] = [];
    let total = 0;
    for (const rel of docs) {
      const text = await this.readText(vscode.Uri.joinPath(this.root, rel)).catch(() => '');
      const isOwnDescription = rel === 'NAPARNIK.md'; // только корневой — описание этого проекта
      const limit = isOwnDescription ? MAX_ATTACHED_TOTAL_CHARS : MAX_ATTACHED_DOC_CHARS;
      if (!text || (text.length > limit && !isOwnDescription) || total + Math.min(text.length, limit) > MAX_ATTACHED_TOTAL_CHARS) continue;
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

  private async listDir(relPath: string, depth = 1): Promise<string> {
    const uri = await this.resolve(relPath);
    if (depth > 1) {
      const { text, overflow } = await this.buildTree(uri, Math.min(depth, TREE_MAX_DEPTH), 300);
      const note = overflow ? '\n(показана часть — для подробностей смотри вложенные папки отдельно)' : '';
      return `Дерево ${relPath} (глубина ${depth}):\n${text}${note}`;
    }
    const entries = await this.sortedEntries(uri);
    const shown = entries.slice(0, MAX_DIR_ENTRIES).map(([name, type]) => name + (type === vscode.FileType.Directory ? '/' : ''));
    const more = entries.length > MAX_DIR_ENTRIES ? `\n… ещё ${entries.length - MAX_DIR_ENTRIES}` : '';
    return `Содержимое ${relPath}:\n${shown.join('\n') || '(пусто)'}${more}`;
  }

  private async readFile(relPath: string): Promise<string> {
    const uri = await this.resolve(relPath);
    if ((await vscode.workspace.fs.stat(uri)).type & vscode.FileType.Directory) {
      return `${relPath} — это папка, а не файл. ${await this.listDir(relPath, 2)}`;
    }
    const text = await this.readText(uri);
    if (text.length > MAX_FILE_CHARS) {
      return `Файл ${relPath} (показаны первые ${MAX_FILE_CHARS} символов из ${text.length}):\n${text.slice(0, MAX_FILE_CHARS)}`;
    }
    return `Файл ${relPath}:\n${text}`;
  }

  private async search(query: string, glob?: string): Promise<string> {
    const files = await this.collectFiles(glob ? globToRegExp(glob) : undefined, MAX_SEARCH_FILES);
    const needle = query.toLowerCase();
    const results: string[] = [];

    for (const file of files) {
      if (results.length >= MAX_SEARCH_RESULTS) break;
      // Совпадение в пути: ищут часто по имени объекта, а не по тексту
      const rel = this.relative(file);
      if (rel.toLowerCase().includes(needle)) {
        results.push(`${rel} (совпадение в пути)`);
      }

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

  /*
   * Что скрыто, решает проект, а не расширение: только то, что игнорирует git.
   * Учитываются .gitignore во всех папках (как в git — каждый относительно своей папки) и сама папка .git,
   * которую git никогда не считает частью проекта. Своих списков папок в коде нет.
   * Скрытые пути не видны в карте проекта и поиске, но явно прочитать их можно.
   */
  private readonly gitignores = new Map<string, Promise<RegExp[]>>();

  private async isIgnored(rel: string): Promise<boolean> {
    const parts = rel.split('/');
    if (parts.includes('.git')) return true;
    // Проверяем путь .gitignore каждой папки-предка: корня, затем вложенных
    for (let i = 0; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      const relToDir = parts.slice(i).join('/');
      if (!this.gitignores.has(dir)) this.gitignores.set(dir, this.loadGitignore(dir));
      if ((await this.gitignores.get(dir)!).some((re) => re.test(relToDir))) return true;
    }
    return false;
  }

  private async loadGitignore(dir: string): Promise<RegExp[]> {
    try {
      const text = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(this.root, dir, '.gitignore')));
      return parseGitignore(text);
    } catch {
      return [];
    }
  }

  private relative(uri: vscode.Uri): string {
    return path.relative(this.root.fsPath, uri.fsPath).split(path.sep).join('/');
  }

  private async sortedEntries(uri: vscode.Uri): Promise<[string, vscode.FileType][]> {
    const entries = await vscode.workspace.fs.readDirectory(uri);
    const base = this.relative(uri);
    const visible: [string, vscode.FileType][] = [];
    for (const entry of entries) {
      if (!(await this.isIgnored(base ? `${base}/${entry[0]}` : entry[0]))) visible.push(entry);
    }
    return visible
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

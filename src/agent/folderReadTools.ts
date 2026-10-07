/**
 * Чтение приложенных папок, которые не поместились в сообщение, — когда «Доступ к проекту» выключен.
 * Только @read_file, @list_dir и @search и только внутри этих папок. Без зависимости от vscode.
 */
import type { AgentTools } from './agentLoop';
import type { AgentCommand } from './protocol';

/** Команда изменения в режиме только чтения: без неё модель после отказа снова писала правку, и она становилась ответом */
export const READ_ONLY_HINT =
  'Изменять файлы здесь нельзя: «Доступ к проекту» выключен, можно только читать приложенные папки. ' +
  'Не пиши команды изменения — ответь текстом: что нужно изменить, и что для правки нужно включить «Доступ к проекту».';

/** Напоминание продолжить в режиме только чтения — общее толкало модель к @create_file */
export const READ_ONLY_CONTINUE_HINT =
  'Ты не прислал команд. Если нужно что-то прочитать — ответь командами @read_file, @search или @list_dir; иначе ответь текстом по уже прочитанному.';

/** Инструмент написан текстом — в режиме только чтения перечисляем только команды чтения */
export const READ_ONLY_TEXT_TOOL_HINT =
  'Вызов инструмента не выполнен: ты написал его текстом. Здесь доступны только команды чтения @read_file, @search, @list_dir — или ответь текстом.';

/** Модель всё же ответила командой изменения — вместо сырой команды пользователь видит это */
export const READ_ONLY_ANSWER =
  'Изменять файлы без «Доступа к проекту» Напарник не может — он только читает приложенные папки. Включите «Доступ к проекту» и повторите запрос.';

/** Строка ответа — команда изменения файла, в том числе выдуманная (@write_file): любая @…_file, кроме @read_file */
export const EDIT_COMMAND_LINE = /^\s*@(?!read_file)\w+_file\b/m;

/** Путь внутри одной из папок (папки — с «/» на конце); «..» не пускаем — проверка realpath есть и ниже, в WorkspaceTools */
export function isInsideFolders(path: string, folders: string[]): boolean {
  const norm = path.trim().replace(/\\/g, '/').replace(/^\.?\/+/, '');
  if (norm.split('/').includes('..')) return false;
  return folders.some((folder) => norm === folder.replace(/\/$/, '') || norm.startsWith(folder));
}

export class FolderReadTools implements AgentTools {
  readonly readOnly = true;

  constructor(
    private readonly inner: AgentTools,
    private readonly folders: string[],
  ) {}

  async run(cmd: AgentCommand): Promise<string> {
    const list = this.folders.join(', ');
    switch (cmd.kind) {
      case 'read_file':
      case 'list_dir':
        return isInsideFolders(cmd.path, this.folders)
          ? this.inner.run(cmd)
          : // Короткое имя файла модель потом пересказывала как «файл вне папки» — просим полный путь
            `Ошибка: ${cmd.path} — не внутри приложенных папок. Путь указывай полностью от корня проекта; без «Доступа к проекту» можно читать только внутри: ${list}.`;
      case 'search': {
        const glob = cmd.glob?.trim();
        // Маска без * ? и точки — имя папки («@search текст | tests»): папка внутри — ищем в ней, иначе — во всех
        if (glob && !/[*?.]/.test(glob)) {
          return isInsideFolders(glob, this.folders)
            ? this.inner.run({ kind: 'search', query: cmd.query, glob: `${glob.replace(/\/$/, '')}/**/*` })
            : this.run({ kind: 'search', query: cmd.query });
        }
        // Маска внутри папки — как есть; иначе берём имя файла из маски и ищем в каждой папке
        if (glob?.includes('/') && isInsideFolders(glob, this.folders)) return this.inner.run(cmd);
        const name = glob?.split('/').pop() || '*';
        const results: string[] = [];
        for (const folder of this.folders) {
          results.push(await this.inner.run({ kind: 'search', query: cmd.query, glob: `${folder}**/${name}` }));
        }
        return results.join('\n\n');
      }
      default:
        return `Ошибка: команда @${cmd.kind} недоступна (папки для чтения: ${list}). ${READ_ONLY_HINT}`;
    }
  }
}

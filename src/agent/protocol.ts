/**
 * Текстовый протокол команд для работы с проектом.
 * API 1С:Напарник не принимает инструменты клиента, поэтому команды описываются модели
 * в промпте, а расширение находит их в ответе и выполняет само.
 */

export type AgentCommand =
  | { kind: 'list_dir'; path: string }
  | { kind: 'read_file'; path: string }
  | { kind: 'search'; query: string; glob?: string }
  | { kind: 'edit_file'; path: string; edits: SearchReplace[] }
  | { kind: 'create_file'; path: string; content: string };

export interface SearchReplace {
  search: string;
  replace: string;
}

export const MAX_AGENT_STEPS = 12;

/** Ответ модели, когда она вызывает инструмент 1С:EDT вместо @-команды */
export const AGENT_UNAVAILABLE_TOOL_HINT =
  'Этот инструмент недоступен: работа идёт не из 1С:EDT. Для файлов проекта используй команды @list_dir, @read_file, @search, @edit_file, @create_file — ответь ими.';

/** Инструкция для модели. Отправляется первым сообщением чата с включённым доступом к проекту */
export function buildAgentPrompt(projectTree: { text: string; complete: boolean }, question: string): string {
  const treeTitle = projectTree.complete
    ? 'Структура проекта (полная — все папки и файлы уже перечислены, @list_dir для них не нужен):'
    : 'Структура проекта (только верхние уровни — остальное смотри через @list_dir или @search):';
  // Команды — строки с «@», без XML: XML-теги сервер 1С:Напарник принимает за вызов своих инструментов
  return `Ты работаешь внутри редактора VS Code и имеешь доступ к проекту пользователя через команды.
Чтобы выполнить команды, ответь ТОЛЬКО командами, каждая с новой строки, без пояснений. Можно несколько команд в одном ответе.

Чтение:
@list_dir ПАПКА — содержимое папки ("." — корень проекта)
@read_file ФАЙЛ — текст файла
@search ТЕКСТ | МАСКА — поиск текста по файлам; « | МАСКА» необязательна, пример: @search Сообщить | **/*.bsl

Изменение (пользователь увидит diff и сам решит, применять ли):
@edit_file ФАЙЛ
<<<<<<< SEARCH
точный фрагмент текущего текста файла
=======
новый фрагмент
>>>>>>> REPLACE
@end

@create_file ФАЙЛ
полный текст нового файла
@end

Правила:
- Для файлов проекта используй ТОЛЬКО эти @-команды. Инструменты WriteSystemFile, ReadSystemFile, GetObject_in_Project, FindRelated_in_Project, FindSimilar_in_Project, Task, TodoWrite здесь не работают (нет сессии 1С:EDT). Поиск по ИТС и документации платформы использовать можно.
- Не используй XML-теги — только строки с @.
- Пути — относительно корня проекта, через "/". НЕ угадывай пути: сначала @list_dir или @search.
- В выгрузке конфигурации 1С модули лежат так: <Тип>/<Имя>/Ext/ObjectModule.bsl, ManagerModule.bsl, Module.bsl (общие модули), Forms/<Форма>/Ext/Form/Module.bsl.
- Перед правкой прочитай файл: SEARCH должен в точности совпадать с текстом файла и быть уникальным. В одном @edit_file может быть несколько блоков.
- Я выполню команды и пришлю результат. Когда информации достаточно — дай обычный ответ без команд.

${treeTitle}
${projectTree.text}

Вопрос пользователя: ${question}`;
}

const LINE_COMMAND = /^\s*@(list_dir|read_file|search|edit_file|create_file)\b[ \t]*(.*)$/;

/** Найти команды в ответе модели. Пустой массив — это обычный ответ */
export function parseCommands(text: string): AgentCommand[] {
  const commands = parseLineCommands(text);
  // Запасной вариант: модель всё же написала XML-теги
  return commands.length > 0 ? commands : parseXmlCommands(text);
}

/** Основной синтаксис: строки «@команда аргументы», блоки правок до «@end» */
function parseLineCommands(text: string): AgentCommand[] {
  const commands: AgentCommand[] = [];
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_COMMAND);
    if (!m) continue;
    const [, kind, rawArg] = m;
    const arg = unquote(rawArg);

    if (kind === 'list_dir' || kind === 'read_file') {
      commands.push({ kind, path: arg || '.' });
    } else if (kind === 'search') {
      const [query, glob] = rawArg.split(/\s+\|\s+/).map(unquote);
      if (query) commands.push({ kind: 'search', query, glob: glob || undefined });
    } else {
      // Тело блока — до @end (или до конца ответа, если модель забыла @end)
      const body: string[] = [];
      while (++i < lines.length && !/^\s*@end\s*$/.test(lines[i])) body.push(lines[i]);
      if (!arg) continue;
      if (kind === 'edit_file') {
        const edits = parseSearchReplace(body.join('\n'));
        if (edits.length > 0) commands.push({ kind, path: arg, edits });
      } else {
        commands.push({ kind: 'create_file', path: arg, content: stripFence(body.join('\n')) });
      }
    }
  }
  return commands;
}

/** Запасной синтаксис: <read_file path="a"/> или <read_file><path>a</path></read_file> */
function parseXmlCommands(text: string): AgentCommand[] {
  const found: { index: number; command: AgentCommand }[] = [];

  for (const m of text.matchAll(/<(list_dir|read_file|search)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/g)) {
    const attrs = { ...parseChildElements(m[3] ?? ''), ...parseAttributes(m[2]) };
    const tag = m[1];
    if (tag === 'search') {
      if (attrs.query) found.push({ index: m.index!, command: { kind: 'search', query: attrs.query, glob: attrs.glob || undefined } });
    } else if (attrs.path !== undefined) {
      found.push({ index: m.index!, command: { kind: tag as 'list_dir' | 'read_file', path: attrs.path || '.' } });
    }
  }

  for (const m of text.matchAll(/<edit_file\b([^>]*)>([\s\S]*?)<\/edit_file>/g)) {
    const path = parseAttributes(m[1]).path ?? parseChildElements(m[2]).path;
    const edits = parseSearchReplace(m[2]);
    if (path && edits.length > 0) found.push({ index: m.index!, command: { kind: 'edit_file', path, edits } });
  }

  for (const m of text.matchAll(/<create_file\b([^>]*)>\n?([\s\S]*?)\n?<\/create_file>/g)) {
    let body = m[2];
    let path = parseAttributes(m[1]).path;
    if (!path) {
      const children = parseChildElements(body);
      path = children.path;
      body = children.content ?? body.replace(/<path>[\s\S]*?<\/path>\n?/, '');
    }
    if (path) found.push({ index: m.index!, command: { kind: 'create_file', path, content: body } });
  }

  return found.sort((a, b) => a.index - b.index).map((f) => f.command);
}

/** Блоки SEARCH/REPLACE в формате, привычном моделям (как у aider) */
export function parseSearchReplace(body: string): SearchReplace[] {
  const edits: SearchReplace[] = [];
  const re = /<{5,9} SEARCH\r?\n([\s\S]*?)\r?\n?={5,9}\r?\n([\s\S]*?)\r?\n?>{5,9} REPLACE/g;
  for (const m of body.matchAll(re)) {
    edits.push({ search: m[1], replace: m[2] });
  }
  return edits;
}

/** Убрать команды из текста, который показывается пользователю во время стрима */
export function stripCommandsForDisplay(text: string): string {
  return text
    // Блоки правок — до @end или до конца (ещё печатается)
    .replace(/^[ \t]*@(edit_file|create_file)\b[\s\S]*?(^[ \t]*@end[ \t]*$|(?![\s\S]))/gm, '')
    .replace(/^[ \t]*@(list_dir|read_file|search)\b.*$/gm, '')
    // Недописанная команда в конце стрима: «@rea»
    .replace(/(^|\n)[ \t]*@\w*$/, '')
    // XML-вариант
    .replace(/<edit_file[\s\S]*?(<\/edit_file>|$)/g, '')
    .replace(/<create_file[\s\S]*?(<\/create_file>|$)/g, '')
    .replace(/<(list_dir|read_file|search)\b[\s\S]*?(\/>|<\/\1>|$)/g, '')
    .replace(/<[a-z_]*(\s[^>]*)?$/, '')
    // Пустые ``` после вырезания команд
    .replace(/```\w*\s*```/g, '')
    .replace(/```\w*\s*$/, '')
    .trim();
}

/** Применить блоки SEARCH/REPLACE к тексту. Ошибка — с понятным для модели описанием */
export function applySearchReplace(original: string, edits: SearchReplace[]): string {
  // Файлы 1С часто в CRLF: сравниваем в LF, затем возвращаем исходные переводы строк
  const usesCrlf = original.includes('\r\n');
  let text = original.replace(/\r\n/g, '\n');

  edits.forEach((edit, i) => {
    const search = edit.search.replace(/\r\n/g, '\n');
    const replace = edit.replace.replace(/\r\n/g, '\n');
    if (!search) {
      throw new Error(`Блок ${i + 1}: пустой SEARCH`);
    }
    const first = text.indexOf(search);
    if (first === -1) {
      throw new Error(`Блок ${i + 1}: фрагмент SEARCH не найден в файле. Перечитай файл и повтори правку.`);
    }
    if (text.indexOf(search, first + 1) !== -1) {
      throw new Error(`Блок ${i + 1}: фрагмент SEARCH встречается в файле несколько раз. Добавь в него соседние строки.`);
    }
    text = text.slice(0, first) + replace + text.slice(first + search.length);
  });

  return usesCrlf ? text.replace(/\n/g, '\r\n') : text;
}

/** Короткое описание шага для чата */
export function describeCommand(cmd: AgentCommand): string {
  switch (cmd.kind) {
    case 'list_dir':
      return `📂 Смотрю ${cmd.path === '.' ? 'корень проекта' : cmd.path}`;
    case 'read_file':
      return `📄 Читаю ${cmd.path}`;
    case 'search':
      return `🔍 Ищу «${cmd.query}»${cmd.glob ? ` в ${cmd.glob}` : ''}`;
    case 'edit_file':
      return `✏️ Предлагаю правку ${cmd.path}`;
    case 'create_file':
      return `🆕 Предлагаю создать ${cmd.path}`;
  }
}

/** Убрать кавычки/бэктики вокруг аргумента: `src/a.bsl` → src/a.bsl */
function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^[`"']+|[`"']+$/g, '');
}

/** Модель иногда оборачивает содержимое нового файла в ``` */
function stripFence(body: string): string {
  const m = body.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  return m ? m[1] : body;
}

/** <path>a</path><query>b</query> → { path: 'a', query: 'b' } */
function parseChildElements(body: string): Record<string, string> {
  const children: Record<string, string> = {};
  for (const m of body.matchAll(/<(path|query|glob|content)>\n?([\s\S]*?)\n?<\/\1>/g)) {
    children[m[1]] = m[1] === 'content' ? m[2] : m[2].trim();
  }
  return children;
}

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const m of raw.matchAll(/(\w+)\s*=\s*"([^"]*)"/g)) {
    attrs[m[1]] = m[2];
  }
  return attrs;
}

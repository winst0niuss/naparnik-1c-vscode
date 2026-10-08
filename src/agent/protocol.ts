/**
 * Текстовый протокол команд для работы с проектом.
 * API 1С:Напарник не принимает инструменты клиента, поэтому команды описываются модели
 * в промпте, а расширение находит их в ответе и выполняет само.
 */

export type AgentCommand =
  | { kind: 'list_dir'; path: string; depth?: number }
  | { kind: 'read_file'; path: string }
  | { kind: 'search'; query: string; glob?: string }
  | { kind: 'edit_file'; path: string; edits: SearchReplace[] }
  | { kind: 'create_file'; path: string; content: string }
  | { kind: 'move_file'; from: string; to: string }
  | { kind: 'copy_file'; from: string; to: string }
  | { kind: 'delete_file'; path: string }
  | GitCommand;

/** Команды git: каждую подтверждает пользователь, выполняет встроенное расширение Git */
export type GitCommand =
  | { kind: 'git_status' }
  | { kind: 'git_diff'; path?: string }
  | { kind: 'git_log'; count?: number }
  | { kind: 'git_branch' }
  | { kind: 'git_create_branch'; name: string }
  | { kind: 'git_checkout'; branch: string }
  | { kind: 'git_commit'; message: string }
  // flags — то, что модель дописала по привычке CLI («--force», «--rebase»): такие варианты не выполняем
  | { kind: 'git_pull'; flags?: string }
  | { kind: 'git_push'; flags?: string };

export function isGitCommand(cmd: AgentCommand): cmd is GitCommand {
  return cmd.kind.startsWith('git_');
}

/** Git-действие пришло в одном ответе с чтением git, результатов которого модель ещё не видела, — не выполнено */
export const GIT_DEFERRED_HINT =
  'Не выполнено: команда пришла в одном ответе с @git_status/@git_diff/@git_log/@git_branch, их результатов ты ещё не видел. ' +
  'Посмотри результаты выше; если действие всё ещё нужно и о нём просили — пришли его отдельным ответом (сообщение коммита — по diff).';

/** Модель написала git-команду, которой нет (reset, rebase, stash…) */
export const GIT_UNSUPPORTED_HINT =
  'Такой git-команды нет: доступны только @git_status, @git_diff, @git_log, @git_branch, @git_create_branch, @git_checkout, @git_commit, @git_pull, @git_push. ' +
  'Не пиши её снова — ответь текстом: это нужно сделать вручную, и как именно.';

/** Модель настаивает на несуществующей git-команде — пользователю вместо сырой строки */
export function gitUnsupportedAnswer(text: string): string {
  const command = text.trim().split('\n')[0].replace(/^@git[ _]?/i, 'git ');
  return `Эту операцию git Напарник не выполняет. Если она нужна, выполните её вручную в терминале:\n\n\`\`\`\n${command}\n\`\`\``;
}

/** Команды git, которые только читают — их результат нужен модели, состояние репозитория не меняется */
export const GIT_READ_COMMANDS = new Set<AgentCommand['kind']>(['git_status', 'git_diff', 'git_log', 'git_branch']);

export interface SearchReplace {
  search: string;
  replace: string;
}

export const MAX_AGENT_STEPS = 12;

/** Что уже известно о проекте: документация, инструкции ИИ-инструментов и правила пользователя */
export interface ProjectContext {
  /** Все найденные файлы документации и инструкций (пути) */
  docs: string[];
  /** Короткие файлы документации — прикладываются целиком */
  attached: { path: string; text: string }[];
  /** Правила пользователя из .rules/ — приоритетнее всего остального */
  rules: { path: string; text: string }[];
}

export const EMPTY_CONTEXT: ProjectContext = { docs: [], attached: [], rules: [] };

function renderContext(ctx: ProjectContext): string {
  const parts: string[] = [];
  if (ctx.rules.length > 0) {
    parts.push(
      'Правила проекта от пользователя (папка .rules) — выполняй их в первую очередь, они важнее остальных инструкций:\n' +
        ctx.rules.map((r) => `--- ${r.path} ---\n${r.text.trim()}`).join('\n\n'),
    );
  }
  if (ctx.docs.length === 0) {
    parts.push('Документации (README и т. п.) и инструкций для ИИ-инструментов (CLAUDE.md, AGENTS.md…) в проекте нет — не ищи их, изучай код.');
  } else {
    const attachedPaths = new Set(ctx.attached.map((a) => a.path));
    const rest = ctx.docs.filter((d) => !attachedPaths.has(d));
    parts.push(
      'Документация и инструкции в проекте. Сначала опирайся на них и только потом исследуй код. ' +
        'Если инструкции из разных файлов противоречат друг другу — скажи об этом, не выбирай молча.' +
        (ctx.attached.length > 0 ? '\n\n' + ctx.attached.map((a) => `--- ${a.path} ---\n${a.text.trim()}`).join('\n\n') : '') +
        (rest.length > 0 ? `\n\nЕщё есть (читай через @read_file, когда нужно): ${rest.join(', ')}` : ''),
    );
  }
  return parts.length > 0 ? parts.join('\n\n') + '\n\n' : '';
}

/** Ответ модели, когда она вызывает инструмент 1С:EDT вместо @-команды */
export const AGENT_UNAVAILABLE_TOOL_HINT =
  'Этот инструмент недоступен: работа идёт не из 1С:EDT. Для файлов проекта используй команды @list_dir, @read_file, @search, @edit_file, @create_file — ответь ими.';

/** Ответ пустой или модель зациклилась на инструментах (план TodoWrite, субагенты Task) — как продолжить */
export const AGENT_CONTINUE_HINT =
  'Не вызывай больше инструменты: план (TodoWrite) не нужен, субагентов (Task) и инструментов 1С:EDT здесь нет. ' +
  'Продолжи задачу сам командами @list_dir, @read_file, @search, @edit_file, @create_file — несколько в одном ответе — или дай итоговый ответ текстом.';

/** Команды git в первом сообщении — только если проект в репозитории */
const GIT_PROMPT = `
Git (чтение выполняется сразу, остальное пользователь подтверждает):
@git_status — текущая ветка, изменённые и новые файлы
@git_diff ФАЙЛ — незакоммиченные изменения файла; без ФАЙЛА — всех файлов
@git_log N — последние N коммитов (по умолчанию 10)
@git_branch — список веток
@git_create_branch ИМЯ — создать ветку и перейти на неё
@git_checkout ВЕТКА — перейти на существующую ветку
@git_commit
СООБЩЕНИЕ
@end
— коммит; СООБЩЕНИЕ — сам текст коммита без подписей («сообщение:») и кавычек: первая строка — заголовок, описание — после пустой строки
@git_pull — подтянуть изменения текущей ветки
@git_push — отправить текущую ветку
Git-команды — только когда пользователь спрашивает о git или просит; коммит, смену ветки, pull и push — только по его прямой просьбе.
Коммит: сначала одним ответом @git_status, @git_diff и @git_log 5, а @git_commit — следующим ответом, по их результатам: сообщение по diff, в стиле последних коммитов и правил проекта. В коммит войдут подготовленные (staged) файлы, а если их нет — все изменения; @git add не нужен.
Делай только то git-действие, о котором прямо просили. Не просьба о другом действии:
- «запушь» — не просьба закоммитить: незакоммиченное не коммить и pull не делай, а скажи, что мешает;
- «перейди на ветку X», а её нет — не просьба создать X;
- «push --force», «удали ветку», «reset» — не просьба о похожей доступной команде: их нет, объясни, как сделать вручную, и ничего не выполняй;
- после pull не меняй файлы.
Пользователь отклонил git-действие или git вернул ошибку — не повторяй и не обходи другими командами, сообщи пользователю.
Ревью изменений — по @git_diff: реальные проблемы с файлом и причиной, без мелочей оформления; сам ничего не правь, пока не попросят.
Других операций git (reset, rebase, merge, stash, удаление веток, push --force) нет.
`;

/** Инструкция для модели. Отправляется первым сообщением чата с включённым доступом к проекту */
export function buildAgentPrompt(
  projectTree: { text: string; complete: boolean },
  question: string,
  context: ProjectContext = EMPTY_CONTEXT,
  /** Проект в репозитории git — описать команды git */
  git = false,
): string {
  const treeTitle = projectTree.complete
    ? 'Структура проекта (полная — все папки и файлы уже перечислены, @list_dir для них не нужен):'
    : 'Структура проекта (только верхние уровни — остальное смотри через @list_dir или @search):';
  // Команды — строки с «@», без XML: XML-теги сервер 1С:Напарник принимает за вызов своих инструментов
  return `Ты работаешь внутри редактора VS Code и имеешь доступ к проекту пользователя через команды.
Чтобы выполнить команды, ответь ТОЛЬКО командами, каждая с новой строки, без пояснений. Можно несколько команд в одном ответе.

Чтение:
@list_dir ПАПКА | ГЛУБИНА — дерево папки ("." — корень проекта; глубина 1–4, по умолчанию 1)
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

@move_file ОТКУДА | КУДА — перенести или переименовать файл или папку: в старом месте не останется
@copy_file ОТКУДА | КУДА — копия, исходный файл остаётся
@delete_file ПУТЬ — удалить файл или папку (в корзину)
КУДА — новый путь или существующая папка, в которую переносится.
${git ? GIT_PROMPT : ''}
Экономь шаги — их число ограничено:
- В одном ответе отправляй сразу все нужные команды: например, 5–10 @read_file подряд, а не по одному файлу за ответ.
- Структура проекта ниже уже показана — не смотри повторно то, что в ней видно. Чтобы увидеть глубже, используй @list_dir ПАПКА | 3.
- @read_file — только для файлов; папки смотри через @list_dir.

Правила:
- Для файлов проекта используй ТОЛЬКО эти @-команды. Инструменты WriteSystemFile, ReadSystemFile, GetObject_in_Project, FindRelated_in_Project, FindSimilar_in_Project, Task здесь не работают (нет сессии 1С:EDT). Поиск по ИТС и документации платформы использовать можно.
- Не используй XML-теги — только строки с @.
- Пути — относительно корня проекта, через "/". НЕ угадывай пути: сначала @list_dir или @search.
- В выгрузке конфигурации 1С модули лежат так: <Тип>/<Имя>/Ext/ObjectModule.bsl, ManagerModule.bsl, Module.bsl (общие модули), Forms/<Форма>/Ext/Form/Module.bsl.
- Перед правкой прочитай файл: SEARCH должен в точности совпадать с текстом файла и быть уникальным. В одном @edit_file может быть несколько блоков.
- Каждый @edit_file и @create_file закрывай строкой @end.
- «Перенеси», «перемести», «переименуй» — только @move_file (не создавай копию через @create_file). «Скопируй» — @copy_file, «удали» — @delete_file.
- Если пользователь просит запомнить правило («запомни…», «всегда делай…», «добавь правило…») — записывай его в папку .rules/: один файл на тему (.rules/naming.md, .rules/code-style.md…), сначала проверь, есть ли подходящий файл.
- В итоговом ответе перечисляй только то, что действительно сделано по результатам команд.
- Я выполню команды и пришлю результат. Когда информации достаточно — дай обычный ответ без команд.

${treeTitle}
${projectTree.text}

${renderContext(context)}Вопрос пользователя: ${question}`;
}

const GIT_KINDS = 'git_status|git_diff|git_log|git_branch|git_create_branch|git_checkout|git_commit|git_pull|git_push';
// «@git push», «@git commit» — модель иногда пишет как в CLI, через пробел
const GIT_SPACED = /^(\s*)@git[ \t]+(status|diff|log|branch|checkout|commit|pull|push)\b/;
const LINE_COMMAND = new RegExp(
  `^\\s*@(list_dir|read_file|search|edit_file|create_file|move_file|copy_file|delete_file|${GIT_KINDS})\\b[ \\t]*(.*)$`,
);
/** Начало блока до @end: правка, новый файл, коммит с сообщением на следующих строках */
const BLOCK_START = /^\s*@(edit_file|create_file|git_commit)\b/;

/** Найти команды в ответе модели. Пустой массив — это обычный ответ */
export function parseCommands(text: string): AgentCommand[] {
  const commands = parseLineCommands(text);
  // Запасной вариант: модель всё же написала XML-теги
  return commands.length > 0 ? commands : parseXmlCommands(text);
}

/** Основной синтаксис: строки «@команда аргументы», блоки правок до «@end» */
function parseLineCommands(text: string): AgentCommand[] {
  const commands: AgentCommand[] = [];
  const lines = text.split(/\r?\n/).map((l) => l.replace(GIT_SPACED, '$1@git_$2'));

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(LINE_COMMAND);
    if (!m) continue;
    // Модель часто дописывает «@end» в ту же строку: «@read_file a.md @end» — это не часть пути
    const [, kind] = m;
    const rawArg = m[2].replace(/\s*@end\s*$/, '');
    const arg = unquote(rawArg);

    if (kind === 'list_dir') {
      // «@list_dir src | 3» — дерево папки на несколько уровней одной командой
      const [dir, depthRaw] = rawArg.split(/\s+\|\s+/).map(unquote);
      const depth = Math.min(Math.max(Number(depthRaw) || 1, 1), 4);
      commands.push(depth > 1 ? { kind, path: dir || '.', depth } : { kind, path: dir || '.' });
    } else if (kind === 'read_file') {
      commands.push({ kind, path: arg || '.' });
    } else if (kind === 'search') {
      const [query, glob] = rawArg.split(/\s+\|\s+/).map(unquote);
      if (query) commands.push({ kind: 'search', query, glob: glob || undefined });
    } else if (kind === 'delete_file') {
      if (arg) commands.push({ kind, path: arg });
    } else if (kind === 'move_file' || kind === 'copy_file') {
      const pair = splitPathPair(rawArg);
      if (pair) commands.push({ kind, from: pair[0], to: pair[1] });
    } else if (kind === 'git_commit' && arg) {
      // «@git_commit fix: сообщение» — однострочное сообщение без блока; «-m "…"» — привычка CLI
      const message = unquote(arg.replace(/^(-a\s+)?-a?m\s+/, ''));
      if (message) commands.push({ kind, message });
    } else if (kind.startsWith('git_') && kind !== 'git_commit') {
      const git = parseGitCommand(kind, arg);
      if (git) commands.push(git);
    } else {
      // Тело блока — до @end. Модель иногда забывает @end: тогда блок закрывает следующая @-команда или конец ответа
      const body: string[] = [];
      while (++i < lines.length && !/^\s*@end\s*$/.test(lines[i])) {
        if (startsNextCommand(lines, i)) {
          i--; // эту строку разберёт внешний цикл
          break;
        }
        body.push(lines[i]);
      }
      if (kind === 'git_commit') {
        const message = stripFence(body.join('\n')).trim();
        if (message) commands.push({ kind, message });
        continue;
      }
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

/**
 * Строка внутри блока @create_file/@edit_file — начало следующей команды (модель забыла @end)
 * или часть текста файла (например, документация с примером «@read_file …»)?
 * Новый блок правки — всегда команда. Команда чтения — команда, только если дальше нет @end,
 * который закрыл бы текущий блок.
 */
function startsNextCommand(lines: string[], i: number): boolean {
  const m = lines[i].match(LINE_COMMAND);
  if (!m) return false;
  if (BLOCK_START.test(lines[i])) return true;
  for (let j = i + 1; j < lines.length; j++) {
    if (/^\s*@end\s*$/.test(lines[j])) return false;
    if (BLOCK_START.test(lines[j])) return true;
  }
  return true;
}

/** Аргументы git-команды из строки: «@git_log 5», «@git_diff src/a.bsl», «@git_checkout develop» */
function parseGitCommand(kind: string, arg: string): GitCommand | undefined {
  switch (kind) {
    case 'git_status':
    case 'git_branch':
      return { kind };
    case 'git_pull':
    case 'git_push': {
      // «origin main» не мешает — всегда текущая ветка; флаги («--force», «--rebase») — отдельная операция
      const flags = arg.split(/\s+/).filter((a) => a.startsWith('-')).join(' ');
      return flags ? { kind, flags } : { kind };
    }
    case 'git_diff': {
      // «--staged», «--cached» и т. п. не нужны: diff и так показывает подготовленное отдельно
      const path = unquote(arg.split(/\s+/).filter((a) => a && !a.startsWith('-')).join(' '));
      return path ? { kind, path } : { kind };
    }
    case 'git_log': {
      const count = Number(arg.match(/\d+/)?.[0]);
      return count > 0 ? { kind, count } : { kind };
    }
    case 'git_create_branch':
      return arg ? { kind, name: arg } : undefined;
    case 'git_checkout': {
      // «@git_checkout -b имя» — создание ветки, как в CLI
      const create = arg.match(/^-b\s+(\S+)$/);
      if (create) return { kind: 'git_create_branch', name: unquote(create[1]) };
      return arg ? { kind, branch: arg } : undefined;
    }
  }
  return undefined;
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
  if (edits.length > 0) return edits;
  // Модель иногда закрывает блок вторым «=======» вместо «>>>>>>> REPLACE» (наблюдалось на живом API)
  // или не закрывает вовсе: тогда REPLACE — до такой строки, до следующего SEARCH или до конца тела
  const loose = /<{5,9} SEARCH\r?\n([\s\S]*?)\r?\n={5,9}[ \t]*\r?\n([\s\S]*?)(?:\r?\n={5,9}[ \t]*(?=\r?\n|$)|(?=\r?\n<{5,9} SEARCH)|\r?\n?$)/g;
  for (const m of body.matchAll(loose)) {
    edits.push({ search: m[1], replace: m[2].replace(/\r?\n$/, '') });
  }
  return edits;
}

/** Убрать команды из текста, который показывается пользователю во время стрима */
export function stripCommandsForDisplay(text: string): string {
  return text
    // Блоки правок — до @end или до конца (ещё печатается)
    .replace(/^[ \t]*@(edit_file|create_file|git_commit[ \t]*$)[\s\S]*?(^[ \t]*@end[ \t]*$|(?![\s\S]))/gm, '')
    .replace(/^[ \t]*@(list_dir|read_file|search|move_file|copy_file|delete_file|git_\w+)\b.*$/gm, '')
    // Недописанная команда в конце стрима: «@rea»
    .replace(/(^|\n)[ \t]*@\w*$/, '')
    // XML-вариант
    .replace(/<edit_file[\s\S]*?(<\/edit_file>|$)/g, '')
    .replace(/<create_file[\s\S]*?(<\/create_file>|$)/g, '')
    .replace(/<(list_dir|read_file|search)\b[\s\S]*?(\/>|<\/\1>|$)/g, '')
    // Недописанный тег в конце стрима: «<read_fi», «<edit_file path="a». Не «Если А < Б» в коде — там после «<» не буква
    .replace(/<[a-z_]+(\s[^>\n]*)?$/, '')
    // Пустые ``` после вырезания команд
    .replace(/```\w*\s*```/g, '')
    .replace(/```\w*\s*$/, '')
    .trim();
}

/**
 * Модель сейчас пишет содержимое файла: в конце стрима есть @create_file/@edit_file без @end.
 * Нужно, чтобы показать «Пишет файл… N символов» вместо «думает».
 */
export function findUnfinishedWrite(text: string): { path: string; chars: number; isNew: boolean } | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/^\s*@end\s*$/.test(lines[i])) return undefined;
    const m = lines[i].match(/^\s*@(create_file|edit_file)[ \t]+(.+)$/);
    if (m) {
      return { path: unquote(m[2]), chars: lines.slice(i + 1).join('\n').length, isNew: m[1] === 'create_file' };
    }
  }
  return undefined;
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
      return `📂 Смотрю ${cmd.path === '.' ? 'корень проекта' : cmd.path}${cmd.depth ? ` (${cmd.depth} ур.)` : ''}`;
    case 'read_file':
      return `📄 Читаю ${cmd.path}`;
    case 'search':
      return `🔍 Ищу «${cmd.query}»${cmd.glob ? ` в ${cmd.glob}` : ''}`;
    case 'edit_file':
      return `✏️ Предлагаю правку ${cmd.path}`;
    case 'create_file':
      return `🆕 Предлагаю создать ${cmd.path}`;
    case 'move_file':
      return `🚚 Предлагаю перенести ${cmd.from} → ${cmd.to}`;
    case 'copy_file':
      return `📑 Предлагаю скопировать ${cmd.from} → ${cmd.to}`;
    case 'delete_file':
      return `🗑️ Предлагаю удалить ${cmd.path}`;
    case 'git_status':
      return '🔀 git status';
    case 'git_diff':
      return `🔀 git diff${cmd.path ? ` ${cmd.path}` : ''}`;
    case 'git_log':
      return `🔀 git log${cmd.count ? ` (${cmd.count})` : ''}`;
    case 'git_branch':
      return '🔀 git branch';
    case 'git_create_branch':
      return `🔀 Предлагаю создать ветку ${cmd.name}`;
    case 'git_checkout':
      return `🔀 Предлагаю перейти на ветку ${cmd.branch}`;
    case 'git_commit':
      return `🔀 Предлагаю коммит «${cmd.message.split('\n')[0]}»`;
    case 'git_pull':
      return `🔀 Предлагаю git pull${cmd.flags ? ` ${cmd.flags}` : ''}`;
    case 'git_push':
      return `🔀 Предлагаю git push${cmd.flags ? ` ${cmd.flags}` : ''}`;
  }
}

// --- Проверка синтаксиса BSL после правки ---

// Фрагмент для проверки модель передаёт в инструмент целиком — большой модуль она печатала бы минутами
export const MAX_SYNTAX_FRAGMENT_CHARS = 20_000;
const METHOD_START = /^\s*(Асинх\s+|Async\s+)?(Процедура|Функция|Procedure|Function)\s/i;
// \b в JS не работает с кириллицей — граница слова через пробел, «;» или конец строки
const METHOD_END = /^\s*(КонецПроцедуры|КонецФункции|EndProcedure|EndFunction)(?=[\s;]|$)/i;

export function isBslPath(path: string): boolean {
  return /\.(bsl|os)$/i.test(path);
}

/**
 * Код для проверки синтаксиса после правки: процедуры и функции, в которые попали изменённые фрагменты, целиком
 * (с директивами &НаСервере над ними). Правка вне процедур — весь модуль. undefined — проверять нечего или слишком много.
 */
export function changedCode(text: string, fragments: string[]): string | undefined {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const full = lines.join('\n');
  const ranges: [number, number][] = [];
  for (const fragment of fragments.map((f) => f.replace(/\r\n/g, '\n')).filter((f) => f.trim())) {
    const located = locateFragment(lines, full, fragment);
    if (!located) continue;
    const [first, last] = located;
    let start = first;
    while (start >= 0 && !METHOD_START.test(lines[start]) && !(start < first && METHOD_END.test(lines[start]))) start--;
    let end = last;
    while (end < lines.length && !METHOD_END.test(lines[end]) && !(end > last && METHOD_START.test(lines[end]))) end++;
    // Фрагмент не внутри процедуры (переменные модуля, области) — проверяем модуль целиком
    if (start < 0 || !METHOD_START.test(lines[start]) || end >= lines.length || !METHOD_END.test(lines[end])) {
      return full.length <= MAX_SYNTAX_FRAGMENT_CHARS ? full : undefined;
    }
    while (start > 0 && /^\s*&/.test(lines[start - 1])) start--;
    ranges.push([start, end]);
  }
  if (ranges.length === 0) return undefined;
  ranges.sort((a, b) => a[0] - b[0]);
  const merged: [number, number][] = [];
  for (const r of ranges) {
    const prev = merged[merged.length - 1];
    if (prev && r[0] <= prev[1] + 1) prev[1] = Math.max(prev[1], r[1]);
    else merged.push([...r]);
  }
  const code = merged.map(([a, b]) => lines.slice(a, b + 1).join('\n')).join('\n\n');
  return code.length <= MAX_SYNTAX_FRAGMENT_CHARS ? code : undefined;
}

/**
 * Строки фрагмента в тексте: дословно, а если файл изменился после правки (форматирование при сохранении) —
 * по первой или последней непустой строке фрагмента, если она в файле одна
 */
function locateFragment(lines: string[], full: string, fragment: string): [number, number] | undefined {
  const fragmentLines = fragment.split('\n');
  const at = full.indexOf(fragment);
  if (at !== -1) {
    const first = full.slice(0, at).split('\n').length - 1;
    return [first, first + fragmentLines.length - 1];
  }
  const trimmed = lines.map((l) => l.trim());
  const nonEmpty = fragmentLines.map((l) => l.trim()).filter(Boolean);
  for (const [anchor, offset] of [
    [nonEmpty[0], fragmentLines.findIndex((l) => l.trim() === nonEmpty[0])],
    [nonEmpty[nonEmpty.length - 1], fragmentLines.map((l) => l.trim()).lastIndexOf(nonEmpty[nonEmpty.length - 1])],
  ] as const) {
    if (!anchor) continue;
    const found = trimmed.flatMap((l, i) => (l === anchor ? [i] : []));
    if (found.length !== 1) continue;
    const first = Math.max(0, found[0] - offset);
    return [first, Math.min(lines.length - 1, first + fragmentLines.length - 1)];
  }
  return undefined;
}

/** Просьба к модели проверить изменённый код серверным инструментом проверки синтаксиса */
export function syntaxCheckRequest(path: string, code: string): string {
  return (
    // «Как поиск по ИТС» и запрет «@validate»: без этого модель в половине ответов писала вызов текстом «@validate code=…»
    `Проверь синтаксис изменённого кода ${path} своим инструментом mcp__syntax-checker__validate — вызови его так же, как поиск по ИТС ` +
    '(это не @-команда, текстом «@validate» не пиши), параметр code — текст ниже ровно как есть, ничего в нём не исправляя: это то, что сейчас в файле. ' +
    // Иначе модель проверяла исправленный «в уме» вариант и отчитывалась об успехе, не применив правку
    'Если найдены ошибки — исправь их в файле через @edit_file, я пришлю новый код на проверку; свой исправленный вариант до правки не проверяй. ' +
    'Если ошибок нет — продолжай задачу, в итоговом ответе коротко укажи результат проверки.\n' +
    '```bsl\n' + code + '\n```'
  );
}

/**
 * «откуда | куда», «откуда -> куда», «откуда → куда» или два пути через пробел.
 * Без явного разделителя пути с пробелами не разобрать — тогда только если слов ровно два
 */
function splitPathPair(raw: string): [string, string] | undefined {
  const parts = raw.split(/\s+\|\s+|\s*(?:->|→)\s*/).map(unquote).filter(Boolean);
  if (parts.length === 2) return [parts[0], parts[1]];
  const words = raw.trim().split(/\s+/).map(unquote).filter(Boolean);
  return words.length === 2 ? [words[0], words[1]] : undefined;
}

/** Убрать кавычки/бэктики вокруг аргумента: `src/a.bsl` → src/a.bsl */
function unquote(value: string | undefined): string {
  return (value ?? '').trim().replace(/^[`"']+|[`"']+$/g, '');
}

/**
 * Модель иногда оборачивает содержимое нового файла в ``` или в блок SEARCH/REPLACE с пустым SEARCH —
 * в файл должен попасть только сам текст
 */
function stripFence(body: string): string {
  const fence = body.match(/^\s*```[\w-]*\n([\s\S]*?)\n```\s*$/);
  if (fence) return fence[1];
  const edits = parseSearchReplace(body);
  if (edits.length === 1 && !edits[0].search.trim() && /^\s*<{5,9} SEARCH/.test(body) && />{5,9} REPLACE\s*$/.test(body)) {
    return edits[0].replace;
  }
  return body;
}

/** Ответ похож на правку, но без команды @edit_file — модель забыла формат */
export function looksLikeMalformedEdit(text: string): boolean {
  return /<{5,9} SEARCH/.test(text) && />{5,9} REPLACE/.test(text) && parseCommands(text).length === 0;
}

/**
 * Инструменты 1С:EDT, которые можно выполнить самим: ReadSystemFile — как @read_file, WriteSystemFile — как
 * @create_file (с подтверждением; существующий файл не перезаписывается). Модель упорно зовёт их
 * (на живом API — 12 раз подряд после отказов), в том числе с путями «attachment://README.md».
 * Остальные инструменты EDT (поиск по проекту EDT, субагенты Task) — нет
 */
export function emulatedCommand(call: { function?: { name?: string; arguments?: string } }): AgentCommand | undefined {
  const name = call.function?.name;
  if (name !== 'ReadSystemFile' && name !== 'WriteSystemFile') return undefined;
  let args: { path?: unknown; file_path?: unknown; content?: unknown };
  try {
    args = JSON.parse(call.function?.arguments ?? '');
  } catch {
    return undefined;
  }
  const raw = args.path ?? args.file_path;
  const path = typeof raw === 'string' ? raw.replace(/^[a-z]+:\/\//i, '').trim() : '';
  // Путь-UUID — идентификатор вложения сервера, а не файл проекта
  if (!path || /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(path)) return undefined;
  if (name === 'ReadSystemFile') return { kind: 'read_file', path };
  return typeof args.content === 'string' ? { kind: 'create_file', path, content: args.content } : undefined;
}

/**
 * Модель написала вызов инструмента текстом: «@validate code=…», «@TodoWrite todos=…», «mcp__syntax-checker__validate(…)».
 * Ответ без команд, который начинается с «@имя», — не наша команда (наши уже разобраны)
 */
export function looksLikeTextToolCall(text: string): boolean {
  return /^\s*(@[a-z_][\w-]*|mcp__[\w-]+)/i.test(text) && parseCommands(text).length === 0;
}

export const TEXT_TOOL_CALL_HINT =
  'Вызов инструмента не выполнен: ты написал его текстом. Инструменты (mcp__syntax-checker__validate, поиск по ИТС) вызывай как инструменты, а не текстом в ответе; @-команды — только @list_dir, @read_file, @search, @edit_file, @create_file, @move_file, @copy_file, @delete_file и @git_… из списка команд git.';

export const MALFORMED_EDIT_HINT =
  'Правка не выполнена: блоки SEARCH/REPLACE должны быть внутри команды — строка «@edit_file путь», затем блоки, затем «@end». Повтори правку в этом формате.';

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

/**
 * Агентный цикл: ответ модели с @-командами → выполняем → отправляем результаты → следующий ответ.
 * Без зависимости от vscode: инструменты передаются интерфейсом, поэтому цикл тестируется на моках.
 */
import { ChatAnswer, StreamCallbacks } from '../api/client';
import {
  AGENT_CONTINUE_HINT,
  AGENT_UNAVAILABLE_TOOL_HINT,
  AgentCommand,
  GIT_DEFERRED_HINT,
  GIT_READ_COMMANDS,
  GIT_UNSUPPORTED_HINT,
  gitUnsupportedAnswer,
  MALFORMED_EDIT_HINT,
  TEXT_TOOL_CALL_HINT,
  changedCode,
  describeCommand,
  emulatedCommand,
  isBslPath,
  isGitCommand,
  looksLikeMalformedEdit,
  looksLikeTextToolCall,
  parseCommands,
  syntaxCheckRequest,
} from './protocol';
import { EDIT_COMMAND_LINE, READ_ONLY_ANSWER, READ_ONLY_CONTINUE_HINT, READ_ONLY_HINT, READ_ONLY_TEXT_TOOL_HINT } from './folderReadTools';

/** То, что нужно циклу от клиента API */
export interface AgentClient {
  sendMessage(conversationId: string, message: string, parentUuid: string | undefined, callbacks: StreamCallbacks, signal?: AbortSignal): Promise<ChatAnswer>;
}

/** То, что нужно циклу от инструментов проекта */
export interface AgentTools {
  run(cmd: AgentCommand): Promise<string>;
  /** Текст файла после правки — для проверки синтаксиса BSL. Нет метода — проверка не просится */
  readFileText?(path: string): Promise<string>;
  /** Только чтение (приложенная папка без «Доступа к проекту») — правки не напоминаем, а отговариваем */
  readOnly?: boolean;
}

export interface AgentLoopOptions {
  client: AgentClient;
  conversationId: string;
  parentUuid: string | undefined;
  /** Первое сообщение (вопрос с контекстом) */
  message: string;
  /** Нет инструментов — обычный ответ без команд */
  tools?: AgentTools;
  maxSteps: number;
  signal: AbortSignal;
  /** Поток текста ответа (для отображения) */
  onText: (partial: string) => void;
  onToolCalls?: (names: string[]) => void;
  onRejectedTools?: (names: string[]) => void;
  /** Выполняется команда — показать шаг в чате */
  onStep?: (description: string) => void;
  /** Начался новый ответ модели (после результатов команд) — сбросить отображаемый текст */
  onNextRound?: () => void;
  /**
   * Проверка, что задача выполнена (например, /init создал NAPARNIK.md).
   * Возвращает подсказку модели, если не выполнена, — тогда цикл продолжается (до двух раз).
   * answerText — ответ модели без команд (по нему видно, отказалась ли модель или решила, что делать нечего).
   */
  checkDone?: (executed: AgentCommand[], answerText: string) => string | undefined;
}

export interface AgentLoopResult extends ChatAnswer {
  /** Сколько раз модель отправляла команды */
  steps: number;
  /** Модель упёрлась в лимит, и ответ получен в режиме «заверши с тем, что есть» */
  finishedByLimit: boolean;
}

/** Последний шаг: модели — завершить задачу по собранному, а не обрываться с ошибкой */
export const FINISH_HINT =
  'Лимит шагов исчерпан — команды чтения (@list_dir, @read_file, @search) больше выполняться не будут. ' +
  'Заверши задачу сейчас по уже собранной информации: если нужно создать или изменить файл — сделай это командами @create_file/@edit_file в этом ответе; иначе дай итоговый ответ.';

const READ_COMMANDS = new Set<AgentCommand['kind']>(['list_dir', 'read_file', 'search']);

/**
 * Модель описала, что собирается сделать («Читаю package.json…»), но не прислала команд.
 * Короткий ответ-намерение — признак того, что задача брошена на полпути.
 */
export function looksLikeUnfinishedIntent(text: string): boolean {
  const t = text.trim();
  if (t.length > 500) return false;
  // Модель спрашивает пользователя («Хотите, чтобы я закоммитил?») или предлагает («если нужно — сделаю git diff») —
  // ждём его ответа, а не подталкиваем: напоминание продолжить заставляло её делать предложенное
  // (коммит, push; после pull — заново применить diff к файлам)
  if (t.endsWith('?') || /если (нужно|надо|хотите|потребуется)|дайте знать|могу /i.test(t)) return false;
  // «Использую @-команды:» — короткий ответ, оборванный на двоеточии, явно не итог (наблюдалось на живом API)
  if (t.length < 200 && t.endsWith(':')) return true;
  // Глагол действия «сейчас/дальше» — признак намерения; «создан», «готово» — признак выполненной задачи.
  // Границы слов — через пробелы/знаки: \b в JS не работает с кириллицей
  const word = (re: string) => new RegExp(`(^|[\\s,.!:;«(—-])(${re})(?=[\\s,.!:;»)—-]|$)`, 'i');
  const intent = word(
    'читаю|прочитаю|смотрю|посмотрю|изучу|изучаю|проверю|открою|найду|поищу|начну|продолжу|перейду|сейчас|далее|дальше|затем|' +
      'нужно|надо|добавлю|исправлю|внесу|изменю|создам|сделаю|допишу|перенесу|удалю',
  );
  const done = word('создан[аоы]?|создал[аи]?|готово|готов|применен[аоы]?|применил[аи]?|выполнен[аоы]?|сделан[аоы]?|добавлен[аоы]?|изменен[аоы]?|итог[а-я]*');
  return intent.test(t) && !done.test(t);
}

export const CONTINUE_HINT = 'Ты описал, что собираешься сделать, но не прислал команд. Выполни это сейчас командами (@read_file, @list_dir, @search, @create_file…) — несколько в одном ответе.';

/** Правка или создание файла действительно выполнены (не отклонены и не упали) */
function isApplied(result: string): boolean {
  return /^Правка .+ применена\.$|^Файл .+ создан\.$/.test(result.trim());
}

export async function runAgentLoop(opts: AgentLoopOptions): Promise<AgentLoopResult> {
  const { client, conversationId, tools, maxSteps, signal } = opts;
  let parentUuid = opts.parentUuid;
  let message = opts.message;
  let formatReminded = false;
  let finishing = false; // FINISH_HINT уже отправлен
  let nudges = 0; // напоминаний «продолжай командами»
  // Последняя просьба проверить синтаксис — с текстом из файла. Повторяется, если модель написала вызов текстом:
  // иначе она передаёт в инструмент свою версию кода из того текста, а не то, что лежит в файле
  let syntaxRequest = '';
  const executed: AgentCommand[] = [];

  for (let step = 0; ; step++) {
    const answer = await client.sendMessage(
      conversationId,
      message,
      parentUuid,
      {
        onText: opts.onText,
        onToolCalls: opts.onToolCalls,
        onRejectedTools: opts.onRejectedTools,
        unavailableToolHint: tools ? AGENT_UNAVAILABLE_TOOL_HINT : undefined,
        continueHint: tools ? AGENT_CONTINUE_HINT : undefined,
        emulateTool: tools
          ? async (call) => {
              const cmd = emulatedCommand(call);
              if (!cmd) return undefined;
              const description =
                tools.readOnly && !READ_COMMANDS.has(cmd.kind) ? `⛔ Недоступно без доступа к проекту: ${describeCommand(cmd)}` : describeCommand(cmd);
              opts.onStep?.(description);
              executed.push(cmd);
              return `${call.function?.name} здесь не работает — расширение выполнило его как @${cmd.kind}. Дальше используй @-команды.\n\n${await tools.run(cmd)}`;
            }
          : undefined,
      },
      signal,
    );
    parentUuid = answer.assistantUuid;

    let commands = tools ? parseCommands(answer.text) : [];
    // Правка без @edit_file — один раз напоминаем формат, а не показываем блок как ответ.
    // В режиме только чтения формат не напоминаем: модель пишет правку снова, и она становится ответом
    const editAttempt = looksLikeMalformedEdit(answer.text) || (tools?.readOnly && EDIT_COMMAND_LINE.test(answer.text));
    if (tools && commands.length === 0 && editAttempt && !formatReminded) {
      formatReminded = true;
      opts.onNextRound?.();
      message = tools.readOnly ? READ_ONLY_HINT : MALFORMED_EDIT_HINT;
      continue;
    }
    if (commands.length === 0) {
      // Только чтение: модель после READ_ONLY_HINT снова пишет правку — дальше напоминания только толкают её к правкам,
      // а сырая команда стала бы ответом (живой API: 2 из 6)
      if (tools?.readOnly && EDIT_COMMAND_LINE.test(answer.text)) {
        return { ...answer, text: READ_ONLY_ANSWER, steps: step, finishedByLimit: finishing };
      }
      // Несуществующая git-команда («@git reset --hard»): своя подсказка, общая перечисляла команды, и модель повторяла её
      const unsupportedGit = /^\s*@git[ _]?[a-z]/i.test(answer.text);
      if (tools && unsupportedGit && (nudges >= 2 || finishing || step >= maxSteps)) {
        // Модель настаивает — вместо сырой команды пользователь видит, что сделать вручную (живой API: 1 из 6)
        return { ...answer, text: gitUnsupportedAnswer(answer.text), steps: step, finishedByLimit: finishing };
      }
      // Ответ без команд, но задача явно не доделана — до двух напоминаний, если шаги ещё есть
      const notDone = !tools
        ? undefined
        : unsupportedGit && !tools.readOnly
          ? GIT_UNSUPPORTED_HINT
          : looksLikeTextToolCall(answer.text)
          ? tools.readOnly
            ? READ_ONLY_TEXT_TOOL_HINT
            : TEXT_TOOL_CALL_HINT + (syntaxRequest ? `\n\n${syntaxRequest}` : '')
          : opts.checkDone?.(executed, answer.text) ??
            (looksLikeUnfinishedIntent(answer.text) ? (tools.readOnly ? READ_ONLY_CONTINUE_HINT : CONTINUE_HINT) : undefined);
      if (notDone && nudges < 2 && !finishing && step < maxSteps) {
        nudges++;
        opts.onNextRound?.();
        message = notDone;
        continue;
      }
      return { ...answer, steps: step, finishedByLimit: finishing };
    }

    // После FINISH_HINT выполняем только правки; если модель всё равно просит читать — сдаёмся.
    // Больше двух ответов сверх лимита не ждём, чтобы не зациклиться на правках
    if (finishing) {
      commands = commands.filter((c) => !READ_COMMANDS.has(c.kind) && !GIT_READ_COMMANDS.has(c.kind));
      if (commands.length === 0 || step > maxSteps + 1) {
        throw new Error(`Напарник не уложился в ${maxSteps} шагов. Попробуйте сузить вопрос.`);
      }
    }

    const results: string[] = [];
    const checks = new Map<string, string[]>(); // изменённые модули BSL → фрагменты правок
    // Git-действие в одном ответе с чтением git, результатов которого модель ещё не видела, — решено вслепую.
    // Живой API: коммит с сообщением «initial commit» до diff; на «запушь» — pull «на всякий случай» до статуса.
    // Его и следующие git-действия откладываем: модель увидит состояние и пришлёт их отдельным ответом
    const seen = new Set(executed.map((c) => c.kind));
    const sawGitRead = [...GIT_READ_COMMANDS].some((k) => seen.has(k));
    let gitRead = false;
    let deferGit = false;
    for (const cmd of commands) {
      const gitWrite = isGitCommand(cmd) && !GIT_READ_COMMANDS.has(cmd.kind);
      if (GIT_READ_COMMANDS.has(cmd.kind)) gitRead = true;
      // Коммиту нужен уже увиденный diff, остальным — любое увиденное чтение git
      if (gitWrite && gitRead && !(cmd.kind === 'git_commit' ? seen.has('git_diff') : sawGitRead)) deferGit = true;
      if (deferGit && gitWrite) {
        results.push(`### ${describeCommand(cmd)}\n${GIT_DEFERRED_HINT}`);
        continue;
      }
      const description =
        tools?.readOnly && !READ_COMMANDS.has(cmd.kind) ? `⛔ Недоступно без доступа к проекту: ${describeCommand(cmd)}` : describeCommand(cmd);
      opts.onStep?.(description);
      const result = await tools!.run(cmd);
      results.push(`### ${description}\n${result}`);
      executed.push(cmd);
      // Пока пользователь смотрел diff, запрос могли остановить
      if (signal.aborted) throw new Error('Остановлено');
      if ((cmd.kind === 'edit_file' || cmd.kind === 'create_file') && isBslPath(cmd.path) && isApplied(result)) {
        const fragments = cmd.kind === 'edit_file' ? cmd.edits.map((e) => e.replace) : [cmd.content];
        checks.set(cmd.path, [...(checks.get(cmd.path) ?? []), ...fragments]);
      }
    }
    opts.onNextRound?.();
    message = `Результаты команд:\n\n${results.join('\n\n')}`;
    // Применённую правку модуля 1С модель проверяет серверным инструментом проверки синтаксиса
    const requests: string[] = [];
    for (const [path, fragments] of checks) {
      const text = await tools!.readFileText?.(path).catch(() => undefined);
      const code = text === undefined ? undefined : changedCode(text, fragments);
      if (code) requests.push(syntaxCheckRequest(path, code));
    }
    syntaxRequest = requests.join('\n\n');
    if (syntaxRequest) message += `\n\n${syntaxRequest}`;

    if (finishing) {
      // Правки по FINISH_HINT выполнены — дальше только итоговый ответ
      message += '\n\nТеперь дай итоговый ответ без команд.';
    } else if (step + 1 >= maxSteps) {
      finishing = true;
      message += `\n\n${FINISH_HINT}`;
    }
  }
}

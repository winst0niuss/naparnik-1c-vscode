/**
 * Команды git для модели. Выполняет встроенное расширение Git (`vscode.git`), а не терминал:
 * здесь только то, что нужно от его API, поэтому модуль без vscode и тестируется на моках.
 * Чтение (статус, diff, журнал, ветки) — без вопросов; то, что меняет репозиторий, — после подтверждения пользователя.
 * Опасных операций (reset, rebase, push --force, удаление веток, настройки) нет вовсе.
 */
import * as path from 'node:path';
import type { GitCommand } from './protocol';

// --- Подмножество API расширения Git (extensions/git/src/api/git.d.ts) ---

export interface GitUri {
  readonly fsPath: string;
}

export interface GitChange {
  readonly uri: GitUri;
  readonly status: number;
}

export interface GitRef {
  readonly type?: number;
  readonly name?: string;
  readonly commit?: string;
  readonly remote?: string;
}

export interface GitBranch extends GitRef {
  readonly upstream?: { readonly remote: string; readonly name: string };
  readonly ahead?: number;
  readonly behind?: number;
}

export interface GitRepository {
  readonly rootUri: GitUri;
  readonly state: {
    readonly HEAD: GitBranch | undefined;
    readonly remotes: readonly { readonly name: string }[];
    readonly mergeChanges: readonly GitChange[];
    readonly indexChanges: readonly GitChange[];
    readonly workingTreeChanges: readonly GitChange[];
    /** Есть в новых версиях VS Code при настройке git.untrackedChanges = separate */
    readonly untrackedChanges?: readonly GitChange[];
    /** Состояние изменилось (смена ветки, коммит) — для ветки под полем ввода */
    readonly onDidChange?: (listener: () => void) => { dispose(): void };
  };
  status(): Promise<void>;
  diff(cached?: boolean): Promise<string>;
  /** Несмотря на имя — `git diff -- path`: рабочая папка против индекса */
  diffWithHEAD(path: string): Promise<string>;
  /** `git diff --cached -- path` */
  diffIndexWithHEAD(path: string): Promise<string>;
  log(options?: { maxEntries?: number; path?: string }): Promise<{ hash: string; message: string; authorName?: string; authorDate?: Date }[]>;
  getBranches(query: { remote?: boolean }): Promise<GitRef[]>;
  createBranch(name: string, checkout: boolean): Promise<void>;
  checkout(treeish: string): Promise<void>;
  add(paths: string[]): Promise<void>;
  commit(message: string, opts?: { postCommitCommand?: string | null }): Promise<void>;
  pull(): Promise<void>;
  push(remoteName?: string, branchName?: string, setUpstream?: boolean): Promise<void>;
}

/** Status из git.d.ts (const enum — в рантайме только числа) */
const STATUS_LETTER: Record<number, string> = {
  0: 'M', // INDEX_MODIFIED
  1: 'A', // INDEX_ADDED
  2: 'D', // INDEX_DELETED
  3: 'R', // INDEX_RENAMED
  4: 'C', // INDEX_COPIED
  5: 'M', // MODIFIED
  6: 'D', // DELETED
  7: '?', // UNTRACKED
  9: 'A', // INTENT_TO_ADD
  10: 'R', // INTENT_TO_RENAME
  11: 'T', // TYPE_CHANGED
};
const UNTRACKED = 7;
const IGNORED = 8;

// --- Подтверждение ---

/** Что показать в карточке подтверждения — той же, что у переноса и удаления файлов */
export interface GitOperation {
  title: string;
  details: string[];
}

export type ConfirmGit = (operation: GitOperation, signal?: AbortSignal, owner?: string) => Promise<boolean>;

// Результат для модели: большой diff обрезаем, как и чтение файла
export const MAX_DIFF_CHARS = 60_000;
const DEFAULT_LOG = 10;
const MAX_LOG = 50;
const MAX_BRANCHES = 50;
// Сколько файлов коммита перечислить в карточке
const MAX_FILES_SHOWN = 15;

/** Имя ветки по правилам git check-ref-format (упрощённо) */
export function isValidBranchName(name: string): boolean {
  return (
    /^[^\s~^:?*[\\]+$/.test(name) &&
    !name.startsWith('-') &&
    !name.startsWith('/') &&
    !/(^|\/)\./.test(name) &&
    !/\.\.|\/\/|@\{/.test(name) &&
    !/[/.]$|\.lock$/.test(name) &&
    name !== '@'
  );
}

/** Сообщение ошибки git: stderr полезнее «Failed to execute git» */
function gitError(err: unknown): string {
  const e = err as { stderr?: string; message?: string; gitErrorCode?: string };
  // Строки «hint:» git занимают весь вывод и вытесняют саму ошибку
  const lines = (e?.stderr?.trim() || e?.message || String(err)).split('\n').filter((l) => !l.startsWith('hint:'));
  const text = lines.slice(0, 8).join('\n');
  return `Ошибка git${e?.gitErrorCode ? ` (${e.gitErrorCode})` : ''}: ${text}`;
}

/**
 * Слова, которыми просят о git-действии. Действие выполняется, только если такое слово есть в просьбе пользователя
 * или в предыдущем ответе Напарника (пользователь ответил «да» на «закоммитить?»). Живой API: промптом модель не удержать —
 * на «запушь» она коммитила незакоммиченное (6/6), на отклонённый push делала pull, на «перейди на release» создавала ветку
 */
const REQUEST_WORDS: Partial<Record<GitCommand['kind'], RegExp>> = {
  // Глагол, а не «коммиты»: на «запушь мои коммиты» модель коммитила незакоммиченное
  git_commit: /закомм?ит|(сдела|созда)[а-яё]* комм?ит|комм?итни|commit(?!s)|зафиксир/i,
  git_push: /пуш|push|отправ|выгрузи|залей|синхрониз/i,
  // (?<![а-яё]) — «пул», но не «популярный»: \b в JS не работает с кириллицей
  git_pull: /(?<![а-яё])пулл?|pull|подтян|обнови|скачай|синхрониз/i,
  git_create_branch: /созда|нов(ую|ая|ой) ветк|заведи|create|new branch|-b\s/i,
  git_checkout: /ветк|branch|бранч|переключ|перейд|checkout|чекаут|вернись/i,
};

const REQUEST_LABEL: Partial<Record<GitCommand['kind'], string>> = {
  git_commit: 'коммит',
  git_push: 'push',
  git_pull: 'pull',
  git_create_branch: 'создать ветку',
  git_checkout: 'переключить ветку',
};

/** Просил ли пользователь об этом git-действии. request не задан — проверки нет */
export function requestedByUser(kind: GitCommand['kind'], request: string | undefined): boolean {
  const words = REQUEST_WORDS[kind];
  return request === undefined || !words || words.test(request);
}

/** Команды, меняющие репозиторий: отказ пользователя или ошибка git блокирует повтор до конца запроса */
const WRITE_KINDS = new Set<GitCommand['kind']>(['git_create_branch', 'git_checkout', 'git_commit', 'git_pull', 'git_push']);

export class GitTools {
  /**
   * Отклонённые пользователем или git действия этого запроса (GitTools создаётся на каждый запрос).
   * Живой API: после отказа модель предлагала тот же коммит 7–10 раз, после отклонённого push крутила pull/push,
   * пробовала --rebase и временные ветки
   */
  private readonly blocked = new Map<GitCommand['kind'], string>();

  constructor(
    private readonly repo: GitRepository,
    /** Корень проекта: пути для модели — от него, как у остальных команд */
    private readonly workspaceRoot: string,
    private readonly confirm: ConfirmGit,
    private readonly signal?: AbortSignal,
    private readonly owner?: string,
    /** Просьба пользователя и предыдущий ответ Напарника — по ним видно, о каких git-действиях просили */
    private readonly request?: string,
  ) {}

  async run(cmd: GitCommand): Promise<string> {
    if (!requestedByUser(cmd.kind, this.request)) {
      // Без «сделай то, о чём просили» модель после отказа в коммите не делала и запрошенный push (живой API: 5 из 6)
      return `Не выполнено: пользователь не просил ${REQUEST_LABEL[cmd.kind]}. Выполни только то, о чём он просил, если это возможно без этого действия, а про ${REQUEST_LABEL[cmd.kind]} скажи ему в ответе.`;
    }
    const before = this.blocked.get(cmd.kind);
    if (before) return `Не выполнено: в этом запросе уже было «${before}» Не повторяй и не обходи другими командами — сообщи пользователю.`;
    const result = await this.execute(cmd);
    if (WRITE_KINDS.has(cmd.kind) && /^(Пользователь отклонил|Ошибка git|Push отклонён|После pull конфликты)/.test(result)) {
      this.blocked.set(cmd.kind, result.split('\n')[0]);
    }
    return result;
  }

  private async execute(cmd: GitCommand): Promise<string> {
    try {
      // Состояние (ветка, изменения) расширение Git обновляет с задержкой: сразу после открытия репозитория HEAD ещё пуст
      await this.repo.status();
      switch (cmd.kind) {
        case 'git_status':
          return await this.statusText();
        case 'git_diff':
          return await this.diffText(cmd.path ? this.resolve(cmd.path) : undefined);
        case 'git_log':
          return await this.logText(Math.min(Math.max(cmd.count ?? DEFAULT_LOG, 1), MAX_LOG), cmd.path ? this.resolve(cmd.path) : undefined);
        case 'git_branch':
          return await this.branchText();
        case 'git_create_branch':
          return await this.createBranch(cmd.name);
        case 'git_checkout':
          return await this.checkout(cmd.branch);
        case 'git_commit':
          return await this.commit(cmd.message);
        case 'git_pull':
        case 'git_push':
          // Только обычные pull и push: --force перезаписывает историю в remote, --rebase переписывает локальную
          if (cmd.flags) {
            return `Ошибка: ${cmd.kind.replace('_', ' ')} ${cmd.flags} недоступен — только ${cmd.kind.replace('_', ' ')} без параметров. Если нужно именно так, пользователь сделает это вручную.`;
          }
          return cmd.kind === 'git_pull' ? await this.pull() : await this.push();
      }
    } catch (err) {
      return gitError(err);
    }
  }

  /** Локальные ветки */
  async branchNames(): Promise<string[]> {
    await this.repo.status();
    return (await this.repo.getBranches({ remote: false })).flatMap((b) => (b.name ? [b.name] : []));
  }

  /** Есть ли что коммитить */
  async hasChanges(): Promise<boolean> {
    await this.repo.status();
    const c = this.changes();
    return c.staged.length + c.unstaged.length + c.untracked.length + c.conflicts.length > 0;
  }

  /** Ветка и изменённые файлы — как короткий `git status`. Состояние обновляют run и hasChanges */
  async statusText(): Promise<string> {
    const { HEAD } = this.repo.state;
    const lines = [`Ветка: ${this.branchLine(HEAD)}`];
    const { staged, unstaged, untracked, conflicts } = this.changes();
    const section = (title: string, changes: GitChange[]) => {
      if (changes.length > 0) lines.push(`${title}:`, ...changes.map((c) => `  ${STATUS_LETTER[c.status] ?? '?'} ${this.relative(c.uri.fsPath)}`));
    };
    section('Конфликты', conflicts);
    section('Подготовлено к коммиту (staged)', staged);
    section('Изменено, не подготовлено', unstaged);
    section('Новые, не отслеживаются', untracked);
    if (lines.length === 1) lines.push('Изменений нет.');
    return lines.join('\n');
  }

  /** Незакоммиченные изменения: подготовленные и нет — раздельно, новые файлы — списком */
  async diffText(target?: string): Promise<string> {
    const { untracked } = this.changes();
    const newFiles = untracked.map((c) => c.uri.fsPath).filter((p) => !target || p === target || p.startsWith(target + path.sep));
    const staged = target ? await this.repo.diffIndexWithHEAD(target) : await this.repo.diff(true);
    const unstaged = target ? await this.repo.diffWithHEAD(target) : await this.repo.diff(false);
    const parts: string[] = [];
    if (staged.trim()) parts.push(`Подготовлено к коммиту (staged):\n${staged.trimEnd()}`);
    if (unstaged.trim()) parts.push(`Не подготовлено:\n${unstaged.trimEnd()}`);
    if (newFiles.length > 0) {
      parts.push(`Новые файлы (не отслеживаются, содержимое — через @read_file):\n${newFiles.map((p) => this.relative(p)).join('\n')}`);
    }
    if (parts.length === 0) return target ? `Изменений в ${this.relative(target)} нет.` : 'Незакоммиченных изменений нет.';
    const text = parts.join('\n\n');
    return text.length > MAX_DIFF_CHARS
      ? `${text.slice(0, MAX_DIFF_CHARS)}\n… (показаны первые ${MAX_DIFF_CHARS} символов из ${text.length}; diff одного файла — @git_diff ФАЙЛ)`
      : text;
  }

  async logText(count = DEFAULT_LOG, target?: string): Promise<string> {
    // path — `git log -- path`: только коммиты, менявшие файл или папку
    const commits = await this.repo.log(target ? { maxEntries: count, path: target } : { maxEntries: count });
    if (commits.length === 0) return target ? `Коммитов, менявших ${this.relative(target)}, нет.` : 'Коммитов пока нет.';
    return commits
      .map((c) => {
        const date = c.authorDate ? c.authorDate.toISOString().slice(0, 10) + ' ' : '';
        return `${c.hash.slice(0, 7)} ${date}${c.authorName ? c.authorName + ': ' : ''}${c.message.split('\n')[0]}`;
      })
      .join('\n');
  }

  private async branchText(): Promise<string> {
    const current = this.repo.state.HEAD?.name;
    const local = await this.repo.getBranches({ remote: false });
    const remote = (await this.repo.getBranches({ remote: true })).filter((r) => r.remote && !r.name?.endsWith('/HEAD'));
    const lines = ['Локальные ветки:', ...local.slice(0, MAX_BRANCHES).map((b) => `${b.name === current ? '* ' : '  '}${b.name}`)];
    if (local.length > MAX_BRANCHES) lines.push(`  … ещё ${local.length - MAX_BRANCHES}`);
    if (remote.length > 0) {
      lines.push('Ветки remote:', ...remote.slice(0, MAX_BRANCHES).map((b) => `  ${b.name}`));
      if (remote.length > MAX_BRANCHES) lines.push(`  … ещё ${remote.length - MAX_BRANCHES}`);
    }
    if (!current) lines.push(this.repo.state.HEAD ? '(HEAD отсоединён — не на ветке)' : '(коммитов пока нет)');
    return lines.join('\n');
  }

  private async createBranch(name: string): Promise<string> {
    if (!isValidBranchName(name)) return `Ошибка: «${name}» — недопустимое имя ветки.`;
    const local = await this.repo.getBranches({ remote: false });
    if (local.some((b) => b.name === name)) return `Ошибка: ветка ${name} уже есть — перейти на неё: @git_checkout ${name}.`;
    const from = this.repo.state.HEAD?.name ?? 'текущего коммита';
    const confirmed = await this.confirm(
      { title: `Создать ветку ${name} и перейти на неё?`, details: [`От ${from}. Незакоммиченные изменения останутся в рабочей папке.`] },
      this.signal,
      this.owner,
    );
    if (!confirmed) return `Пользователь отклонил создание ветки ${name}.`;
    await this.repo.createBranch(name, true);
    return `Создана ветка ${name}, текущая ветка — ${name}.`;
  }

  private async checkout(branch: string): Promise<string> {
    const current = this.repo.state.HEAD?.name;
    if (branch === current) return `Уже на ветке ${branch}.`;
    const local = (await this.repo.getBranches({ remote: false })).map((b) => b.name);
    const remote = (await this.repo.getBranches({ remote: true })).map((b) => b.name ?? '');
    // «origin/feature» → «feature»: git сам создаст локальную ветку, отслеживающую remote
    const remoteOnly = remote.find((r) => r === branch || r.endsWith('/' + branch));
    const name = local.includes(branch) ? branch : remoteOnly ? remoteOnly.replace(/^[^/]+\//, '') : undefined;
    // Только ветки: переход на коммит или тег отсоединяет HEAD, «checkout -- файл» стёр бы изменения
    // Без подсказки «создать — @git_create_branch»: модель создавала ветку, о которой не просили
    if (!name) return `Ошибка: ветки ${branch} нет. Не создавай её без просьбы — скажи пользователю, какие ветки есть.`;
    if (name === current) return `Уже на ветке ${name}.`;
    const { staged, unstaged } = this.changes();
    const dirty = staged.length + unstaged.length;
    const confirmed = await this.confirm(
      {
        title: `Перейти на ветку ${name}?`,
        details: [
          `Сейчас: ${current ?? 'не на ветке'}.` +
            (dirty > 0 ? ` Незакоммиченных изменений: ${dirty} — git не даст перейти, если они конфликтуют с веткой.` : ''),
        ],
      },
      this.signal,
      this.owner,
    );
    if (!confirmed) return `Пользователь отклонил переход на ветку ${name}.`;
    await this.repo.checkout(name);
    return `Текущая ветка — ${name}.`;
  }

  private async commit(message: string): Promise<string> {
    const { staged, unstaged, untracked, conflicts } = this.changes();
    if (conflicts.length > 0) {
      return `Коммит невозможен: есть неразрешённые конфликты (${conflicts.map((c) => this.relative(c.uri.fsPath)).join(', ')}). Пользователь разрешит их в редакторе.`;
    }
    // Как `git commit`: если что-то уже подготовлено (staged) — только оно, иначе все изменения
    const toCommit = staged.length > 0 ? staged : [...unstaged, ...untracked];
    if (toCommit.length === 0) return 'Коммитить нечего: изменений нет.';
    const paths = [...new Set(toCommit.map((c) => c.uri.fsPath))];
    const shown = paths.slice(0, MAX_FILES_SHOWN).map((p) => this.relative(p));

    const confirmed = await this.confirm(
      {
        title: `Коммит в ${this.repo.state.HEAD?.name ?? 'репозиторий'}?`,
        details: [
          message,
          `Файлы (${paths.length}${staged.length > 0 ? ', только подготовленные' : ''}): ${shown.join(', ')}${paths.length > shown.length ? ` … ещё ${paths.length - shown.length}` : ''}`,
        ],
      },
      this.signal,
      this.owner,
    );
    if (!confirmed) return 'Пользователь отклонил коммит. Не повторяй его — спроси пользователя, что изменить.';
    // Уже подготовленные файлы не добавляем заново — частичная подготовка (git add -p) сохраняется
    if (staged.length === 0) await this.repo.add(paths);
    // postCommitCommand: null — без автоматического push/sync из настройки git.postCommitCommand
    await this.repo.commit(message, { postCommitCommand: null });

    const [last] = await this.repo.log({ maxEntries: 1 });
    const left = staged.length > 0 ? unstaged.length + untracked.length : 0;
    return (
      `Коммит создан${last ? ` ${last.hash.slice(0, 7)}` : ''}: «${message.split('\n')[0]}», файлов: ${paths.length}.` +
      (left > 0 ? ` Не подготовленные изменения (${left}) в коммит не вошли.` : '')
    );
  }

  private async pull(): Promise<string> {
    const { HEAD } = this.repo.state;
    if (!HEAD?.name) return 'Ошибка: сейчас не на ветке — pull невозможен.';
    if (!HEAD.upstream) return `Ошибка: у ветки ${HEAD.name} нет связанной ветки remote — подтягивать неоткуда.`;
    const upstream = `${HEAD.upstream.remote}/${HEAD.upstream.name}`;
    const confirmed = await this.confirm(
      {
        title: `Подтянуть изменения ${upstream} в ${HEAD.name}?`,
        details: [
          (HEAD.behind ? `Отстаёт на ${HEAD.behind} (по последнему fetch). ` : '') + 'Конфликты, если будут, разрешаете вы — Напарник их не трогает.',
        ],
      },
      this.signal,
      this.owner,
    );
    if (!confirmed) return 'Пользователь отклонил git pull.';
    let failure: string | undefined;
    try {
      await this.repo.pull();
    } catch (err) {
      failure = gitError(err);
    }
    await this.repo.status();
    const conflicts = this.changes().conflicts;
    if (conflicts.length > 0) {
      return (
        `После pull конфликты в файлах: ${conflicts.map((c) => this.relative(c.uri.fsPath)).join(', ')}. ` +
        'Не исправляй их сам: скажи пользователю открыть эти файлы — VS Code покажет конфликты для разрешения.'
      );
    }
    // Ветки разошлись, а pull.rebase не настроен — выбор merge или rebase за пользователем, настройки git не меняем
    if (failure && /divergent/i.test(failure)) {
      return `${failure}\nВетки разошлись: в ${upstream} и в ${HEAD.name} есть разные коммиты. Объединить их (merge или rebase) пользователь должен сам.`;
    }
    return failure ?? `Изменения ${upstream} подтянуты в ${HEAD.name}.`;
  }

  private async push(): Promise<string> {
    const { HEAD, remotes } = this.repo.state;
    if (!HEAD?.name) return 'Ошибка: сейчас не на ветке — push невозможен.';
    const remote = HEAD.upstream?.remote ?? (remotes.find((r) => r.name === 'origin') ?? remotes[0])?.name;
    if (!remote) return 'Ошибка: в репозитории нет remote — отправлять некуда.';
    const target = HEAD.upstream ? `${HEAD.upstream.remote}/${HEAD.upstream.name}` : `${remote}/${HEAD.name}`;
    const confirmed = await this.confirm(
      {
        title: `Отправить ${HEAD.name} в ${target}?`,
        details: [
          ...(/^(main|master)$/.test(HEAD.name) ? [`⚠️ ${HEAD.name} — основная ветка: коммиты сразу попадут в неё в ${remote}.`] : []),
          HEAD.upstream ? `Коммитов к отправке: ${HEAD.ahead ?? 0} (без force).` : `Ветки в ${remote} ещё нет — будет создана.`,
        ],
      },
      this.signal,
      this.owner,
    );
    if (!confirmed) return 'Пользователь отклонил git push.';
    try {
      // Без force: если в remote есть новые коммиты, git откажет
      if (HEAD.upstream) await this.repo.push();
      else await this.repo.push(remote, HEAD.name, true);
    } catch (err) {
      const code = (err as { gitErrorCode?: string })?.gitErrorCode;
      // Без подсказки «сделай pull»: модель тогда крутила pull/push сама, без просьбы пользователя
      if (code === 'PushRejected') return 'Push отклонён: в remote есть коммиты, которых нет локально. Pull сам не делай — скажи пользователю, что сначала нужно подтянуть изменения.';
      throw err;
    }
    return `Ветка ${HEAD.name} отправлена в ${target}.`;
  }

  private branchLine(head: GitBranch | undefined): string {
    if (!head) return '(коммитов пока нет)';
    if (!head.name) return `HEAD отсоединён на ${head.commit?.slice(0, 7) ?? '?'}`;
    if (!head.upstream) return `${head.name} (нет связанной ветки remote)`;
    const diff = [head.ahead ? `впереди на ${head.ahead}` : '', head.behind ? `позади на ${head.behind}` : ''].filter(Boolean).join(', ');
    return `${head.name} → ${head.upstream.remote}/${head.upstream.name}${diff ? ` (${diff})` : ''}`;
  }

  private changes() {
    const { indexChanges, workingTreeChanges, mergeChanges, untrackedChanges = [] } = this.repo.state;
    const all = [...workingTreeChanges, ...untrackedChanges].filter((c) => c.status !== IGNORED);
    return {
      staged: [...indexChanges],
      unstaged: all.filter((c) => c.status !== UNTRACKED),
      untracked: all.filter((c) => c.status === UNTRACKED),
      conflicts: [...mergeChanges],
    };
  }

  /** Путь из команды модели — от корня проекта, за его пределы нельзя */
  private resolve(rel: string): string {
    const abs = path.resolve(this.workspaceRoot, rel.trim().replace(/^["'`]|["'`]$/g, ''));
    if (abs !== this.workspaceRoot && !abs.startsWith(this.workspaceRoot + path.sep)) {
      throw new Error(`путь ${rel} вне проекта`);
    }
    return abs;
  }

  private relative(abs: string): string {
    return path.relative(this.workspaceRoot, abs).split(path.sep).join('/') || '.';
  }
}

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { RULES_DIR } from '../slashCommands';

/** Источник инструкций другого ИИ-инструмента для /import */
export interface ImportSource {
  id: string;
  title: string;
  /** Как ещё можно назвать источник в аргументах /import */
  aliases: string[];
  /** Файлы с инструкциями в проекте (путь относительно корня) */
  rules: RegExp;
  /** Папки настроек инструмента: их файлы не переносятся, но попадают в итог как пропущенные */
  settings?: RegExp;
  /** Пользовательские файлы (от домашней папки) — только с явного согласия */
  userFiles: string[];
}

// Папки целиком из домашней папки не берём: в ~/.claude лежат история чатов и кеши, а не правила
export const IMPORT_SOURCES: ImportSource[] = [
  {
    id: 'claude',
    title: 'Claude Code',
    aliases: ['claude-code'],
    rules: /(^|\/)CLAUDE(\.local)?\.md$|^\.claude\/(commands|agents|rules)\/.*\.md$/i,
    settings: /^\.claude\/.*\.json$/i,
    userFiles: ['.claude/CLAUDE.md'],
  },
  {
    id: 'codex',
    title: 'OpenAI Codex и др. (AGENTS.md)',
    aliases: ['agents', 'openai'],
    rules: /(^|\/)AGENTS\.md$|^\.codex\/.*\.md$/i,
    settings: /^\.codex\/.*\.(toml|json)$/i,
    userFiles: ['.codex/AGENTS.md', '.codex/instructions.md'],
  },
  {
    id: 'gemini',
    title: 'Gemini CLI',
    aliases: [],
    rules: /(^|\/)GEMINI\.md$|^\.gemini\/.*\.md$/i,
    settings: /^\.gemini\/.*\.json$/i,
    userFiles: ['.gemini/GEMINI.md'],
  },
  {
    id: 'cursor',
    title: 'Cursor',
    aliases: [],
    rules: /^\.cursorrules$|^\.cursor\/rules\/.*\.mdc?$/i,
    settings: /^\.cursor\/(?!rules\/).*\.json$/i,
    userFiles: [],
  },
  {
    id: 'copilot',
    title: 'GitHub Copilot',
    aliases: ['github'],
    rules: /^\.github\/copilot-instructions\.md$|^\.github\/instructions\/.*\.md$/i,
    userFiles: [],
  },
  {
    id: 'windsurf',
    title: 'Windsurf',
    aliases: [],
    rules: /^\.windsurfrules$|^\.windsurf\/rules\/.*\.md$/i,
    userFiles: [],
  },
];

/** Найденный файл. path — относительно проекта или «~/…» для пользовательских */
export interface FoundFile {
  source: string;
  path: string;
  user: boolean;
  /** Настройки инструмента — не переносятся */
  settings: boolean;
  text: string;
  hash: string;
}

/** Хеши перенесённых файлов: повторный /import берёт только новое и изменившееся */
export type ImportState = Record<string, string>;

export type FileStatus = 'new' | 'changed' | 'imported';

// Одно сообщение модель дочитывает до ~300 тыс. символов — берём с запасом
export const MAX_IMPORT_FILE_CHARS = 30_000;
export const MAX_IMPORT_TOTAL_CHARS = 120_000;

/** Разбор аргументов «/import cursor claude» */
export function parseImportArgs(args: string): { sources: string[]; unknown: string[] } {
  const sources = new Set<string>();
  const unknown: string[] = [];
  for (const word of args.toLowerCase().split(/[\s,]+/).filter(Boolean)) {
    if (word === 'all' || word === 'все') {
      IMPORT_SOURCES.forEach((s) => sources.add(s.id));
      continue;
    }
    const source = IMPORT_SOURCES.find((s) => s.id === word || s.aliases.includes(word));
    if (source) sources.add(source.id);
    else unknown.push(word);
  }
  return { sources: [...sources], unknown };
}

/** К какому источнику относится файл проекта */
export function classifyProjectFile(rel: string): { source: string; settings: boolean } | undefined {
  // В .claude/worktrees Claude Code держит полные копии репозитория — их CLAUDE.md не отдельные правила
  if (/^\.claude\/worktrees\//i.test(rel)) return undefined;
  for (const s of IMPORT_SOURCES) {
    if (s.rules.test(rel)) return { source: s.id, settings: false };
    if (s.settings?.test(rel)) return { source: s.id, settings: true };
  }
  return undefined;
}

export function makeFoundFile(source: string, filePath: string, text: string, user: boolean, settings = false): FoundFile {
  return { source, path: filePath, user, settings, text, hash: createHash('sha1').update(text).digest('hex') };
}

/** Пользовательские файлы инструментов из домашней папки (только существующие) */
export async function readUserFiles(home = os.homedir()): Promise<FoundFile[]> {
  const found: FoundFile[] = [];
  for (const s of IMPORT_SOURCES) {
    for (const rel of s.userFiles) {
      try {
        const text = (await readFile(path.join(home, rel), 'utf8')).replace(/^﻿/, '');
        if (text.trim()) found.push(makeFoundFile(s.id, `~/${rel}`, text, true));
      } catch {
        // файла нет — инструмент не настроен
      }
    }
  }
  return found;
}

export function fileStatus(file: FoundFile, state: ImportState): FileStatus {
  const prev = state[file.path];
  return prev === undefined ? 'new' : prev === file.hash ? 'imported' : 'changed';
}

/** Краткое описание файла: description из заголовка .mdc, первый заголовок или первая строка */
export function describeFile(text: string): string {
  const frontmatter = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const description = frontmatter?.[1].match(/^description:\s*(.+)$/m)?.[1].trim().replace(/^["']|["']$/g, '');
  const body = frontmatter ? text.slice(frontmatter[0].length) : text;
  const first = body
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find((l) => l && !/^(<!--|```)/.test(l));
  const summary = description || first?.replace(/^#+\s*/, '') || '(пусто)';
  return summary.length > 80 ? summary.slice(0, 79) + '…' : summary;
}

const STATUS_LABEL: Record<FileStatus, string> = { new: 'новый', changed: 'изменился', imported: 'уже перенесён' };

/** /import без аргументов: что найдено, ничего не меняется */
export function scanReport(found: FoundFile[], state: ImportState): string {
  if (found.length === 0) {
    return 'Инструкций других ИИ-инструментов не найдено (CLAUDE.md, AGENTS.md, GEMINI.md, правила Cursor, Copilot, Windsurf).';
  }
  const lines = ['**Найдены инструкции ИИ-инструментов** — пока ничего не изменено.', ''];
  for (const s of IMPORT_SOURCES) {
    const files = found.filter((f) => f.source === s.id);
    if (files.length === 0) continue;
    lines.push(`**${s.title}** — \`/import ${s.id}\``);
    for (const f of files) {
      const lineCount = f.text.split('\n').length;
      const note = f.settings
        ? 'настройки инструмента, не переносятся'
        : `${describeFile(f.text)} · ${lineCount} стр. · ${STATUS_LABEL[fileStatus(f, state)]}${f.user ? ' · пользовательский, с вашего согласия' : ''}`;
      lines.push(`- \`${f.path}\` — ${note}`);
    }
    lines.push('');
  }
  const ids = IMPORT_SOURCES.filter((s) => found.some((f) => f.source === s.id && !f.settings)).map((s) => s.id);
  if (ids.length > 0) {
    lines.push(`Перенести в \`${RULES_DIR}/\`: \`/import ${ids.join(' ')}\` или \`/import all\`.`);
  }
  return lines.join('\n');
}

/** Отбор файлов для переноса: только новые и изменившиеся, в пределах объёма сообщения */
export function selectForImport(
  found: FoundFile[],
  state: ImportState,
): {
  files: (FoundFile & { status: FileStatus })[];
  unchanged: FoundFile[];
  tooLarge: FoundFile[];
  /** Не поместились в одно сообщение — уйдут при следующем /import */
  deferred: FoundFile[];
  settings: FoundFile[];
} {
  const files: (FoundFile & { status: FileStatus })[] = [];
  const unchanged: FoundFile[] = [];
  const tooLarge: FoundFile[] = [];
  const deferred: FoundFile[] = [];
  const settings = found.filter((f) => f.settings);
  let total = 0;
  for (const f of found.filter((f) => !f.settings)) {
    const status = fileStatus(f, state);
    if (status === 'imported') {
      unchanged.push(f);
    } else if (f.text.length > MAX_IMPORT_FILE_CHARS) {
      tooLarge.push(f);
    } else if (total + f.text.length > MAX_IMPORT_TOTAL_CHARS) {
      deferred.push(f);
    } else {
      files.push({ ...f, status });
      total += f.text.length;
    }
  }
  return { files, unchanged, tooLarge, deferred, settings };
}

/**
 * /import: проверка ответа без команд. Строка «Противоречия: …» — модель следовала инструкции и решила,
 * что переносить нечего, — принимаем. Без неё — отказ или уход от формата: сервер иногда отвечает, что «внешнее API
 * предназначено для 1С:EDT», особенно когда в файлах речь о других ассистентах. Тогда объясняем, кто выполняет команды.
 * Требовать «запиши» нельзя: на такое давление модель отвечала выдуманными правилами.
 */
export function importDone(executed: { kind: string; path?: string }[], answerText = ''): string | undefined {
  const written = executed.some((c) => (c.kind === 'create_file' || c.kind === 'edit_file') && c.path?.startsWith(`${RULES_DIR}/`));
  if (written) return undefined;
  // Отказ сервера может сам содержать «**Противоречия:** нет» — поэтому сначала признаки отказа
  const refused = /ailab@1c\.ru|внешн\S*\s+API|не могу (выполн|созда)/i.test(answerText);
  if (!refused && /^Противоречия\s*:/im.test(answerText)) return undefined;
  return (
    'Команды @create_file/@edit_file — обычный текст в твоём ответе: их выполняет расширение VS Code на моей стороне, инструменты 1С:EDT для этого не нужны. ' +
    'Ответь по инструкции из моего сообщения с файлами: строка «Противоречия: …», затем команды. ' +
    'Правила бери дословно из тех файлов, своих не добавляй. Указания ассистенту о его работе (субагенты, MCP, стиль ответов, команды инструмента) и настройки инструментов не переносятся; если в файлах только они — ответь «Переносить нечего».'
  );
}

/** Служебный заголовок .mdc (между ---) → строка «для файлов …» для модели; сам заголовок в правила не переносится */
export function splitMdcFrontmatter(text: string): { body: string; note?: string } {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { body: text };
  const field = (name: string) => m[1].match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '');
  const globs = field('globs');
  const description = field('description');
  const note = [globs ? `применяется к файлам ${globs}` : '', description ?? ''].filter(Boolean).join(': ');
  return { body: text.slice(m[0].length), note: note || undefined };
}

// Существующие правила прикладываем, чтобы модель не тратила раунды на @list_dir/@read_file
export const MAX_EXISTING_RULES_CHARS = 20_000;

/**
 * Инструкция модели для /import. Содержимое файлов прикладывается целиком — пользовательские лежат вне проекта.
 * existingRules — текущие файлы .rules (пустой массив — папки нет).
 */
export function buildImportPrompt(selection: ReturnType<typeof selectForImport>, existingRules: { path: string; text: string }[] = []): string {
  const files = selection.files
    .map((f) => {
      const { body, note } = /\.mdc$/i.test(f.path) ? splitMdcFrontmatter(f.text) : { body: f.text, note: undefined };
      const notes = [
        note ?? '',
        f.user ? 'пользовательский — правила разработчика для всех его проектов: правила о коде, комментариях, коммитах из него переноси' : '',
        f.status === 'changed' ? 'изменился после прошлого переноса — перенеси только новое' : '',
      ].filter(Boolean);
      return `--- ${f.path}${notes.length ? ` (${notes.join('; ')})` : ''} ---\n${body.trim()}`;
    })
    .join('\n\n');
  const skipped = [
    ...selection.settings.map((f) => `- ${f.path} — настройки инструмента (не переносятся)`),
    ...selection.tooLarge.map((f) => `- ${f.path} — слишком большой, не передан (${f.text.length} символов)`),
    ...selection.deferred.map((f) => `- ${f.path} — не поместился в сообщение, будет передан при следующем /import`),
    ...selection.unchanged.map((f) => `- ${f.path} — уже перенесён ранее и не изменился`),
  ];

  let rulesTotal = 0;
  const shownRules: string[] = [];
  const notShown: string[] = [];
  for (const r of existingRules) {
    if (rulesTotal + r.text.length > MAX_EXISTING_RULES_CHARS) {
      notShown.push(r.path);
      continue;
    }
    shownRules.push(`--- ${r.path} ---\n${r.text.trim()}`);
    rulesTotal += r.text.length;
  }
  const rulesBlock =
    existingRules.length === 0
      ? `Папки ${RULES_DIR}/ пока нет — правил в ней нет, создавай файлы. Папки .cursor/rules, .windsurf/rules и подобные — это другие папки, не ${RULES_DIR}/.`
      : `Текущие правила в ${RULES_DIR}/:\n\n${shownRules.join('\n\n')}` +
        (notShown.length ? `\n\nНе показаны из-за объёма (прочитай через @read_file, если нужны): ${notShown.join(', ')}` : '');

  return `Перенеси в папку ${RULES_DIR}/ правила проекта из файлов ниже, чтобы дальше в этом проекте ты следовал им напрямую.

Содержимое файлов уже здесь — не ищи и не перечитывай их. Исходные файлы не изменяй. Они лежат вне ${RULES_DIR}/: их правил там нет, пока ты их не запишешь.

${files}
${skipped.length > 0 ? `\nНе переданы:\n${skipped.join('\n')}\n` : ''}
${rulesBlock}

Что переносить — правила о проекте и коде: стиль кода, именование, запреты, архитектурные договорённости, команды сборки и проверки.
Что не переносить:
- настройки инструментов: разрешения, MCP-серверы, модели, хуки, горячие клавиши;
- указания ассистенту о его собственной работе, не связанные с кодом проекта: субагенты, параллельные задачи, стиль и длина ответов, чем искать документацию;
- описание проекта, разовые заметки.
Любое правило о коде, файлах или объектах проекта — в том числе «не изменяй …», «не используй …», соглашения об именовании — правило проекта, переноси. Сомневаешься — переноси: каждую правку я проверю в diff.
Не придумывай правил, которых нет в файлах выше.

Ответь одним сообщением (строка «Противоречия» — исключение из правила «только команды»):
1. Строка «Противоречия: …» — темы, где файлы расходятся между собой или с ${RULES_DIR}/ (например, отступы пробелами и табуляцией), или «Противоречия: нет». Правила этих тем не записывай ни в одном варианте.
2. Сразу команды для остальных правил: один файл — одна тема (${RULES_DIR}/code-style.md, ${RULES_DIR}/git.md, …), существующий файл дополняй через @edit_file, новый создавай через @create_file. Файлы ${RULES_DIR}/ — обычный Markdown (.md) без служебного заголовка; область применения (например, «применяется к файлам *.bsl») пиши заголовком раздела. Существующие строки ${RULES_DIR}/ не меняй и не удаляй — только добавляй новые. Одинаковые правила — одной строкой. Перед каждой командой сверь правило со всеми файлами ${RULES_DIR}/ выше: если оно уже есть в любом из них (даже в файле другой темы) — не записывай его. Правило из файла в подпапке относится к этой подпапке — укажи её.
3. Если переносить нечего — не создавай файлов и так и напиши.
Каждое правило — одна короткая строка в повелительном наклонении.

После результатов команд — итог: что записано (из какого файла в какой), что пропущено и почему — каждое правило из файлов выше должно попасть в одно из двух; вопросы ко мне по каждому противоречию.`;
}

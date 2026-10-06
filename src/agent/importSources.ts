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

/** /import выполнен, если что-то записано в .rules — иначе напоминание модели (до двух раз) */
export function importDone(executed: { kind: string; path?: string }[]): string | undefined {
  const written = executed.some((c) => (c.kind === 'create_file' || c.kind === 'edit_file') && c.path?.startsWith(`${RULES_DIR}/`));
  return written
    ? undefined
    : `В ${RULES_DIR}/ ещё ничего не записано. Запиши сейчас командами @create_file/@edit_file все правила, кроме противоречивых, — вопросы оставь для итога. Если все правила уже есть в ${RULES_DIR}/ — так и напиши в итоге.`;
}

/** Инструкция модели для /import: содержимое файлов прикладывается целиком — пользовательские лежат вне проекта */
export function buildImportPrompt(selection: ReturnType<typeof selectForImport>): string {
  const title = (id: string) => IMPORT_SOURCES.find((s) => s.id === id)?.title ?? id;
  const files = selection.files
    .map((f) => {
      const changed = f.status === 'changed' ? ', изменился после прошлого переноса — перенеси только новое' : '';
      return `--- ${f.path} (${title(f.source)}${f.user ? ', пользовательский — общие правила для всех проектов' : ''}${changed}) ---\n${f.text.trim()}`;
    })
    .join('\n\n');
  const skipped = [
    ...selection.settings.map((f) => `- ${f.path} — настройки инструмента (не переносятся)`),
    ...selection.tooLarge.map((f) => `- ${f.path} — слишком большой, не передан (${f.text.length} символов)`),
    ...selection.deferred.map((f) => `- ${f.path} — не поместился в сообщение, будет передан при следующем /import`),
    ...selection.unchanged.map((f) => `- ${f.path} — уже перенесён ранее и не изменился`),
  ];

  return `Перенеси в папку ${RULES_DIR}/ правила из инструкций других ИИ-инструментов, чтобы в этом проекте ты следовал им напрямую.

Исходные файлы — ниже. Их не изменяй и не удаляй.

${files}
${skipped.length > 0 ? `\nНе переданы расширением:\n${skipped.join('\n')}\n` : ''}
Что переносить — только правила и соглашения о проекте и коде: стиль кода, именование, запреты, архитектурные договорённости, команды сборки и проверки.
Что не переносить:
- настройки самого инструмента: разрешения, MCP-серверы, модели, хуки, горячие клавиши;
- указания о том, как ИИ-ассистенту работать и отвечать: субагенты, параллельные задачи, стиль и длина ответов, какими инструментами искать документацию;
- описание проекта (оно в NAPARNIK.md) и разовые заметки.

Порядок:
1. Посмотри, какие правила уже есть: @list_dir ${RULES_DIR} и прочитай нужные файлы — не дублируй их.
2. Найди противоречия: одно и то же правило с разными значениями в разных источниках или в ${RULES_DIR}/ (например, отступы пробелами в одном файле и табуляцией в другом). Перед первой командой @create_file/@edit_file напиши строку «Противоречия: …» со списком тем (или «Противоречия: нет»). Правила этих тем не записывай ни в одном из вариантов — ни целиком, ни частично.
3. В том же ответе, не дожидаясь моего ответа, запиши все остальные правила. Раздели их по темам: один файл — одна тема (${RULES_DIR}/code-style.md, ${RULES_DIR}/git.md, …). Одинаковые правила из разных источников — одной строкой. Дописывай в подходящий файл через @edit_file или создавай новый через @create_file.
4. В конце — итог: что перенесено (из какого файла в какой) — только то, что действительно записано командами; что пропущено и почему; вопросы ко мне по каждому противоречию.
Каждое правило — одна короткая строка в повелительном наклонении.`;
}

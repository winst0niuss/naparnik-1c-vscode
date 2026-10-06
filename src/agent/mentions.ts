/**
 * @-упоминания файлов в вопросе: «@src/cf/Catalogs/Клиенты/Ext/ObjectModule.bsl», «@"путь с пробелом.md"»
 * или просто «@README.md», если файл с таким именем в проекте один. Без зависимости от vscode.
 */

export const MAX_MENTION_FILE_CHARS = 60_000;
// Одно сообщение модель дочитывает до ~300 тыс. символов, контекст общий на весь чат — берём половину
export const MAX_MENTION_TOTAL_CHARS = 150_000;

/** Упоминания из текста вопроса, по порядку, без повторов */
export function findMentions(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(^|\s)@(?:"([^"]+)"|([^\s"]+))/g)) {
    const raw = m[2] ?? m[3];
    if (raw && !found.includes(raw)) found.push(raw);
  }
  return found;
}

export type MentionResolution = { path: string } | { candidates: string[] } | undefined;

/**
 * Упоминание → путь файла проекта. Точный путь; иначе — путь, который заканчивается упомянутым
 * (имя файла или хвост пути), если такой один. Несколько подходящих — candidates, ни одного — undefined.
 * Знаки препинания в конце («см. @a.bsl.») отбрасываются, если без них путь находится.
 */
export function resolveMention(token: string, paths: string[]): MentionResolution {
  for (const variant of [token, token.replace(/[.,;:!?)»]+$/, '')]) {
    const norm = variant.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!norm) continue;
    if (paths.includes(norm)) return { path: norm };
    const lower = norm.toLowerCase();
    const matches = paths.filter((p) => {
      const pl = p.toLowerCase();
      return pl === lower || pl.endsWith('/' + lower);
    });
    if (matches.length === 1) return { path: matches[0] };
    if (matches.length > 1) return { candidates: matches };
  }
  return undefined;
}

/**
 * Подсказки для автодополнения: все части запроса (через «/») встречаются в пути.
 * Выше — точное имя файла, затем имя с начала, затем вхождение в имя, затем в путь; при равенстве — короче путь.
 * Пустой запрос — файлы верхних уровней.
 */
export function rankPaths(query: string, paths: string[], limit = 30): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const parts = q.split('/').filter(Boolean);
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const pl = path.toLowerCase();
    if (!parts.every((part) => pl.includes(part))) continue;
    const base = pl.slice(pl.lastIndexOf('/') + 1);
    const last = parts[parts.length - 1] ?? '';
    const score = !q ? path.split('/').length : base === last ? 0 : base.startsWith(last) ? 1 : base.includes(last) ? 2 : 3;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((s) => s.path);
}

/** Блок с содержимым упомянутых файлов для модели. Не поместившееся в лимит — в skipped */
export function formatMentionedFiles(files: { path: string; text: string }[]): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  let total = 0;
  for (const f of files) {
    const shown = f.text.slice(0, MAX_MENTION_FILE_CHARS);
    if (total + shown.length > MAX_MENTION_TOTAL_CHARS) {
      skipped.push(f.path);
      continue;
    }
    total += shown.length;
    const note = shown.length < f.text.length ? ` (показаны первые ${shown.length} символов из ${f.text.length})` : '';
    const ext = f.path.match(/\.(\w+)$/)?.[1].toLowerCase() ?? '';
    const lang = ext === 'os' ? 'bsl' : ext;
    parts.push(`--- ${f.path}${note} ---\n\`\`\`${lang}\n${shown}\n\`\`\``);
  }
  const text =
    parts.length === 0
      ? ''
      : `[Файлы, которые пользователь упомянул в вопросе, — содержимое уже здесь, повторно их не читай]\n${parts.join('\n\n')}` +
        (skipped.length ? `\n\nНе приложены из-за объёма: ${skipped.join(', ')}` : '');
  return { text, skipped };
}

/** Путь для вставки в поле ввода: с пробелами — в кавычках */
export function mentionToken(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`;
}

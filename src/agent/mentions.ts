/**
 * @-упоминания файлов и папок в вопросе: «@src/cf/Catalogs/Клиенты/Ext/ObjectModule.bsl», «@"путь с пробелом.md"»,
 * «@src/cf/Catalogs/Клиенты/» или просто «@README.md», если файл с таким именем в проекте один.
 * Папки в списке путей — с «/» на конце. Без зависимости от vscode.
 */

export const MAX_MENTION_FILE_CHARS = 60_000;
// Одно сообщение модель дочитывает до ~300 тыс. символов, контекст общий на весь чат — берём половину
export const MAX_MENTION_TOTAL_CHARS = 150_000;
// Большая папка может не поместиться почти целиком — список неприложенного тоже ограничиваем
const MAX_SKIPPED_LISTED = 200;
// Сколько файлов одной папки читать, выбирая поместившиеся, — дальше только список
export const MAX_FOLDER_FILES_READ = 500;

/** Упоминания из текста вопроса, по порядку, без повторов */
export function findMentions(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(/(^|\s)@(?:"([^"]+)"|([^\s"]+))/g)) {
    const raw = m[2] ?? m[3];
    if (raw && !found.includes(raw)) found.push(raw);
  }
  return found;
}

/** Пути файлов + все их папки (с «/» на конце) — для подсказок и разбора упоминаний */
export function withFolders(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    for (let i = file.indexOf('/'); i > 0; i = file.indexOf('/', i + 1)) folders.add(file.slice(0, i + 1));
  }
  return [...files, ...folders];
}

/**
 * Файлы папки в порядке приложения: сначала описания (README, *.md), затем верхние уровни, затем по имени (f2 раньше f10) —
 * если всё не поместится в лимит, модель получит самое полезное для обзора
 */
export function folderFiles(folder: string, paths: string[]): string[] {
  // Ключи считаем заранее: в папке может быть десятки тысяч файлов
  return paths
    .filter((p) => p.startsWith(folder) && !p.endsWith('/'))
    .map((path) => ({ path, doc: /(^|\/)readme[^/]*$|\.md$/i.test(path) ? 0 : 1, depth: path.split('/').length }))
    .sort((a, b) => a.doc - b.doc || a.depth - b.depth || a.path.localeCompare(b.path, undefined, { numeric: true }))
    .map((f) => f.path);
}

/**
 * Какие файлы папки приложить в пределах budget символов: по порядку folderFiles, только целиком —
 * обрезанный большой файл (например, Form.xml формы 1С) вытеснил бы несколько модулей. Не поместившиеся — в skipped
 */
export function pickFolderFiles(
  files: { path: string; text: string }[],
  budget: number,
): { picked: { path: string; text: string }[]; skipped: string[] } {
  const picked: { path: string; text: string }[] = [];
  const skipped: string[] = [];
  for (const f of files) {
    if (f.text.length <= Math.min(budget, MAX_MENTION_FILE_CHARS)) {
      picked.push(f);
      budget -= f.text.length;
    } else skipped.push(f.path);
  }
  return { picked, skipped };
}

export type MentionResolution = { path: string } | { candidates: string[] } | undefined;

/**
 * Упоминание → путь файла или папки проекта. Точный путь; иначе — путь, который заканчивается упомянутым
 * (имя файла или папки, хвост пути), если такой один. Несколько подходящих — candidates, ни одного — undefined.
 * Папка находится и без «/» на конце; упоминание с «/» на конце — только папка.
 * Знаки препинания в конце («см. @a.bsl.») отбрасываются, если без них путь находится.
 */
export function resolveMention(token: string, paths: string[]): MentionResolution {
  for (const variant of [token, token.replace(/[.,;:!?)»]+$/, '')]) {
    const norm = variant.replace(/\\/g, '/').replace(/^\.?\/+/, '');
    if (!norm) continue;
    if (paths.includes(norm)) return { path: norm };
    if (!norm.endsWith('/') && paths.includes(norm + '/')) return { path: norm + '/' };
    const lower = norm.toLowerCase();
    const matches = paths.filter((p) => {
      // Папку «a/b/» сравниваем как «a/b», если упомянута без «/» на конце
      const pl = lower.endsWith('/') ? p.toLowerCase() : p.toLowerCase().replace(/\/$/, '');
      return pl === lower || pl.endsWith('/' + lower);
    });
    if (matches.length === 1) return { path: matches[0] };
    if (matches.length > 1) return { candidates: matches };
  }
  return undefined;
}

/**
 * Подсказки для автодополнения: все части запроса (через «/») встречаются в пути.
 * Выше — точное имя файла или папки, затем имя с начала, затем вхождение в имя, затем в путь; при равенстве — короче путь.
 * Пустой запрос — файлы и папки верхних уровней.
 */
export function rankPaths(query: string, paths: string[], limit = 30): string[] {
  const q = query.toLowerCase().replace(/\\/g, '/');
  const parts = q.split('/').filter(Boolean);
  const scored: { path: string; score: number }[] = [];
  for (const path of paths) {
    const pl = path.toLowerCase().replace(/\/$/, '');
    if (!parts.every((part) => pl.includes(part))) continue;
    const base = pl.slice(pl.lastIndexOf('/') + 1);
    const last = parts[parts.length - 1] ?? '';
    const score = !q ? pl.split('/').length : base === last ? 0 : base.startsWith(last) ? 1 : base.includes(last) ? 2 : 3;
    scored.push({ path, score });
  }
  return scored
    .sort((a, b) => a.score - b.score || a.path.length - b.path.length || a.path.localeCompare(b.path))
    .slice(0, limit)
    .map((s) => s.path);
}

/**
 * Блок с содержимым упомянутых файлов для модели. Не поместившееся в лимит — в skipped,
 * notRead — файлы папок, которые не приложены (не поместились или не читались)
 */
export function formatMentionedFiles(
  files: { path: string; text: string }[],
  notRead: string[] = [],
): { text: string; skipped: string[] } {
  const parts: string[] = [];
  let skipped: string[] = [];
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
  skipped = skipped.concat(notRead); // не push(...): список папки бывает огромным
  const text =
    parts.length === 0
      ? ''
      : `[Файлы, которые пользователь упомянул в вопросе, — содержимое уже здесь, повторно их не читай]\n${parts.join('\n\n')}` +
        (skipped.length ? `\n\nНе приложены из-за объёма: ${shortList(skipped, MAX_SKIPPED_LISTED)}` : '');
  return { text, skipped };
}

/**
 * Короткие различимые имена: кратчайший хвост пути, не совпадающий с остальными
 * (в 1С почти все модули — ObjectModule.bsl / Module.bsl). Папка — с «/» на конце. Та же логика — у чипов в chat.js
 */
export function shortNames(paths: string[]): string[] {
  const split = paths.map((p) => p.replace(/\/$/, '').split('/'));
  return split.map((own, i) => {
    const tail = (parts: string[], n: number) => parts.slice(-n).join('/');
    let n = 1;
    while (n < own.length && split.some((o, j) => j !== i && tail(o, n) === tail(own, n))) n++;
    return tail(own, n) + (paths[i].endsWith('/') ? '/' : '');
  });
}

/** «a, b, c … и ещё N» */
export function shortList(items: string[], limit: number): string {
  const shown = items.slice(0, limit).join(', ');
  return items.length > limit ? `${shown} … и ещё ${items.length - limit}` : shown;
}

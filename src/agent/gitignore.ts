/**
 * Упрощённый .gitignore: строки-шаблоны с * ** ?, «/» в начале — от корня, без «/» внутри — имя на любом уровне.
 * Исключения «!» не поддерживаются (пропускаются) — лучше показать лишнее, чем скрыть нужное.
 */
export function parseGitignore(text: string): RegExp[] {
  const patterns: RegExp[] = [];
  for (let line of text.split(/\r?\n/)) {
    line = line.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const anchored = line.startsWith('/') || line.slice(0, -1).includes('/');
    line = line.replace(/^\/+|\/+$/g, '');
    if (!line) continue;
    // Совпадение с путём или с любой папкой выше него
    patterns.push(new RegExp(anchored ? `^${patternBody(line)}(/|$)` : `(^|/)${patternBody(line)}(/|$)`));
  }
  return patterns;
}

/**
 * Маска поиска (`**\/*.bsl`, `src/**`, `*.md`) → регулярное выражение для пути относительно корня.
 * Маска без «/» проверяется по имени файла на любом уровне.
 */
export function globToRegExp(glob: string): RegExp {
  const g = glob.trim().replace(/^\.?\/+/, '');
  return new RegExp(g.includes('/') ? `^${patternBody(g)}$` : `(^|/)${patternBody(g)}$`);
}

/** Шаблон с * ** ? → тело регулярного выражения; «**\/» — любое число папок, в том числе ни одной */
function patternBody(pattern: string): string {
  return pattern
    .split('')
    .map((ch) => (ch === '*' ? '\u0000' : ch === '?' ? '[^/]' : ch.replace(/[.+^${}()|[\]\\]/g, '\\$&')))
    .join('')
    .replace(/\u0000\u0000\//g, '(.*/)?')
    .replace(/\u0000\u0000/g, '.*')
    .replace(/\u0000/g, '[^/]*');
}

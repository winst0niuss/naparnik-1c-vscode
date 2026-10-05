/**
 * Контекст редактора: какой файл открыт и что в нём выделено.
 * Чистая логика без vscode — форматирование для модели и подписи для чата.
 */

// Сколько текста прикладывать: выделение — до 20 тыс. символов, файл целиком — до 30 тыс.
export const MAX_SELECTION_CHARS = 20_000;
export const MAX_FILE_CONTEXT_CHARS = 30_000;
const MAX_DIAGNOSTICS = 20;

export interface EditorDiagnostic {
  line: number; // с 1
  severity: 'ошибка' | 'предупреждение';
  message: string;
}

export interface EditorSnapshot {
  /** Путь для модели и чата: относительный внутри проекта, иначе полный */
  path: string;
  /** Файл внутри открытой папки проекта — его можно править командами */
  inWorkspace: boolean;
  languageId: string;
  lineCount: number;
  /** Выделение (номера строк с 1); нет выделения — undefined */
  selection?: { startLine: number; endLine: number; text: string };
  /** Текст файла — нужен, только если ничего не выделено */
  fullText: string;
  diagnostics: EditorDiagnostic[];
}

/** Подпись для чипа над полем ввода и под сообщением: «chatHistory.ts · строки 10–24» */
export function contextLabel(s: EditorSnapshot): string {
  const name = s.path.split('/').pop() ?? s.path;
  if (!s.selection) return name;
  const { startLine, endLine } = s.selection;
  return startLine === endLine ? `${name} · строка ${startLine}` : `${name} · строки ${startLine}–${endLine}`;
}

/** Блок контекста, который добавляется перед вопросом пользователя */
export function formatEditorContext(s: EditorSnapshot): string {
  const lines: string[] = ['[Контекст редактора — файл, открытый у пользователя]'];
  lines.push(
    `Файл: ${s.path} (${s.languageId}, ${s.lineCount} стр.)` +
      (s.inWorkspace ? '' : ' — вне открытого проекта, править его командами нельзя'),
  );

  if (s.selection) {
    const { startLine, endLine } = s.selection;
    const text = truncate(s.selection.text, MAX_SELECTION_CHARS);
    lines.push(`Пользователь выделил строки ${startLine}–${endLine} — вопрос, скорее всего, о них:`);
    lines.push(fence(text, s.languageId));
  } else {
    const text = truncate(s.fullText, MAX_FILE_CONTEXT_CHARS);
    lines.push('Текст файла:');
    lines.push(fence(text, s.languageId));
  }

  // В выделении — ошибки только из него, иначе — по всему файлу
  const diagnostics = s.diagnostics
    .filter((d) => !s.selection || (d.line >= s.selection.startLine && d.line <= s.selection.endLine))
    .slice(0, MAX_DIAGNOSTICS);
  if (diagnostics.length > 0) {
    lines.push('Ошибки и предупреждения VS Code:');
    lines.push(...diagnostics.map((d) => `- строка ${d.line}: ${d.severity}: ${d.message}`));
  }

  lines.push('[Конец контекста редактора]');
  return lines.join('\n');
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (обрезано: показаны первые ${max} символов из ${text.length})` : text;
}

/** Блок кода, который не ломается, если в тексте уже есть ``` */
function fence(text: string, languageId: string): string {
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((m) => m[0].length));
  const ticks = '`'.repeat(longest + 1);
  return `${ticks}${languageId}\n${text}\n${ticks}`;
}

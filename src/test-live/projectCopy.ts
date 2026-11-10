import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

/** Копия проекта для живых тестов без git remote */
export async function makeCopy(original: string, workDir: string): Promise<string> {
  const copy = path.join(workDir, path.basename(original));
  await fs.rm(copy, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });
  // APFS-клон (cp -c): копия мгновенная и не занимает места, пока файлы не изменены
  try {
    execFileSync('cp', ['-cR', original, copy]);
  } catch {
    execFileSync('cp', ['-R', original, copy]);
  }
  // У worktree .git — файл со ссылкой на исходный репозиторий. Заменяем его до любых изменений git.
  const copiedGit = path.join(copy, '.git');
  if (!(await fs.lstat(copiedGit)).isDirectory()) {
    const clone = await fs.mkdtemp(path.join(workDir, 'git-copy-'));
    try {
      execFileSync('git', ['clone', '--no-local', '--no-checkout', '--', original, clone], { stdio: 'pipe' });
      await fs.rm(copiedGit, { force: true });
      await fs.rename(path.join(clone, '.git'), copiedGit);
      // Восстанавливаем staged отдельно: clone не переносит незакоммиченные объекты индекса.
      execFileSync('git', ['-C', copy, 'read-tree', 'HEAD']);
      const staged = execFileSync('git', ['-C', original, 'diff', '--cached', '--binary', 'HEAD'], { maxBuffer: 64 * 1024 * 1024 });
      if (staged.length) execFileSync('git', ['-C', copy, 'apply', '--cached', '--binary'], { input: staged });
    } finally {
      await fs.rm(clone, { recursive: true, force: true });
    }
  }
  const git = (...args: string[]) => execFileSync('git', ['-C', copy, ...args], { encoding: 'utf8' }).trim();
  for (const remote of git('remote').split('\n').filter(Boolean)) git('remote', 'remove', remote);
  if (git('remote', '-v') !== '') throw new Error(`в копии ${copy} остались git remote — прогон остановлен до запросов к API`);
  return copy;
}

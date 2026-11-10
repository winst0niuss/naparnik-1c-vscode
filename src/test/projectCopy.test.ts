import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { makeCopy } from '../test-live/projectCopy';

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

for (const worktree of [false, true]) {
  test(`копия ${worktree ? 'git worktree' : 'обычного репозитория'} изолирована от оригинала и не содержит remote`, async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'naparnik-copy-test-'));
    const repo = path.join(root, 'repo');
    try {
      await fs.mkdir(repo);
      git(repo, 'init', '-b', 'main');
      await fs.writeFile(path.join(repo, 'file.txt'), 'Исходный текст\n');
      git(repo, 'add', 'file.txt');
      git(repo, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-c', 'commit.gpgsign=false', '-c', 'core.hooksPath=/dev/null', 'commit', '-m', 'test: initial');
      git(repo, 'remote', 'add', 'origin', 'https://example.invalid/repo.git');
      const original = worktree ? path.join(root, 'worktree') : repo;
      if (worktree) git(repo, 'worktree', 'add', '-b', 'feature', original);
      await fs.writeFile(path.join(original, 'staged.txt'), 'Подготовлено к коммиту\n');
      const binary = Buffer.from([0, 1, 255, 2]);
      await fs.writeFile(path.join(original, 'staged.bin'), binary);
      git(original, 'add', 'staged.txt', 'staged.bin');
      await fs.writeFile(path.join(original, 'staged.txt'), 'Рабочая версия после staged\n');
      // Сохраняем в копии также незакоммиченные файлы исходного проекта.
      await fs.writeFile(path.join(original, 'file.txt'), 'Изменённый текст\n');
      await fs.writeFile(path.join(original, 'new.txt'), 'Новый файл\n');
      const before = {
        remotes: git(original, 'remote', '-v'),
        status: git(original, 'status', '--porcelain'),
        head: git(original, 'rev-parse', 'HEAD'),
        branch: git(original, 'branch', '--show-current'),
      };

      const copy = await makeCopy(original, path.join(root, 'copies'));

      assert.equal(git(copy, 'remote', '-v'), '');
      assert.equal(await fs.readFile(path.join(copy, 'file.txt'), 'utf8'), 'Изменённый текст\n');
      assert.equal(await fs.readFile(path.join(copy, 'new.txt'), 'utf8'), 'Новый файл\n');
      assert.equal(git(copy, 'status', '--porcelain'), before.status, 'staged и unstaged изменения должны сохраниться');
      assert.equal(git(copy, 'show', ':staged.txt'), 'Подготовлено к коммиту');
      assert.equal(await fs.readFile(path.join(copy, 'staged.txt'), 'utf8'), 'Рабочая версия после staged\n');
      assert.deepEqual(execFileSync('git', ['-C', copy, 'show', ':staged.bin']), binary);
      assert.equal(git(original, 'remote', '-v'), before.remotes, 'remote оригинала должен сохраниться');
      assert.equal(git(original, 'status', '--porcelain'), before.status);
      assert.equal(git(original, 'rev-parse', 'HEAD'), before.head);
      assert.equal(git(original, 'branch', '--show-current'), before.branch);
      assert.notEqual(
        git(copy, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        git(original, 'rev-parse', '--path-format=absolute', '--git-common-dir'),
        'копия должна иметь независимое хранилище git',
      );
      git(copy, 'add', 'file.txt');
      assert.equal(git(original, 'status', '--porcelain'), before.status, 'git add в копии не должен менять индекс оригинала');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
}

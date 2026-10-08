import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { ConfirmGit, GitChange, GitOperation, GitRepository, GitTools, isValidBranchName, requestedByUser } from '../agent/gitTools';

const ROOT = path.resolve('/proj');
const abs = (rel: string) => path.join(ROOT, rel);
const change = (rel: string, status: number): GitChange => ({ uri: { fsPath: abs(rel) }, status });

/** Мок репозитория: записывает вызовы, состояние задаётся в тесте */
function mockRepo(overrides: Partial<GitRepository['state']> = {}) {
  const calls: string[] = [];
  const state = {
    HEAD: { name: 'main', commit: 'abc1234567', upstream: { remote: 'origin', name: 'main' }, ahead: 1, behind: 0 },
    remotes: [{ name: 'origin' }],
    mergeChanges: [] as GitChange[],
    indexChanges: [] as GitChange[],
    workingTreeChanges: [] as GitChange[],
    ...overrides,
  };
  const repo: GitRepository = {
    rootUri: { fsPath: ROOT },
    state,
    status: async () => {},
    diff: async (cached) => (cached ? 'diff --git a/staged.bsl' : 'diff --git a/work.bsl'),
    diffWithHEAD: async (p) => `unstaged ${p}`,
    diffIndexWithHEAD: async () => '',
    log: async ({ maxEntries } = {}) =>
      [{ hash: 'abc1234567', message: 'feat: первое\n\nописание', authorName: 'Автор', authorDate: new Date('2026-10-01T10:00:00Z') }].slice(0, maxEntries),
    getBranches: async ({ remote }) => (remote ? [{ name: 'origin/main', remote: 'origin' }, { name: 'origin/feature', remote: 'origin' }] : [{ name: 'main' }, { name: 'dev' }]),
    createBranch: async (name, checkout) => void calls.push(`createBranch ${name} ${checkout}`),
    checkout: async (t) => void calls.push(`checkout ${t}`),
    add: async (p) => void calls.push(`add ${p.map((x) => path.relative(ROOT, x)).join(',')}`),
    commit: async (m, o) => void calls.push(`commit ${m} ${JSON.stringify(o)}`),
    pull: async () => void calls.push('pull'),
    push: async (...args) => void calls.push(`push ${args.join(' ')}`.trim()),
  };
  return { repo, calls, state };
}

function tools(repo: GitRepository, answer: (op: GitOperation) => ReturnType<ConfirmGit> = async () => true) {
  const asked: GitOperation[] = [];
  const confirm: ConfirmGit = (op) => {
    asked.push(op);
    return answer(op);
  };
  return { git: new GitTools(repo, ROOT, confirm), asked };
}

test('git status — без подтверждения', async () => {
  const { repo } = mockRepo({ workingTreeChanges: [change('a.bsl', 5), change('new.bsl', 7)], indexChanges: [change('b.bsl', 1)] });
  const { git, asked } = tools(repo);
  const text = await git.run({ kind: 'git_status' });
  assert.equal(asked.length, 0);
  assert.match(text, /Ветка: main → origin\/main \(впереди на 1\)/);
  assert.match(text, /Подготовлено к коммиту \(staged\):\n {2}A b\.bsl/);
  assert.match(text, /Изменено, не подготовлено:\n {2}M a\.bsl/);
  assert.match(text, /Новые, не отслеживаются:\n {2}\? new\.bsl/);
});

test('git diff: staged и не подготовленное раздельно, новые файлы списком', async () => {
  const { repo } = mockRepo({ workingTreeChanges: [change('dir/new.bsl', 7)] });
  const { git } = tools(repo);
  const text = await git.run({ kind: 'git_diff' });
  assert.match(text, /Подготовлено к коммиту \(staged\):\ndiff --git a\/staged\.bsl/);
  assert.match(text, /Не подготовлено:\ndiff --git a\/work\.bsl/);
  assert.match(text, /Новые файлы.*:\ndir\/new\.bsl/);
});

test('git diff файла вне проекта — ошибка', async () => {
  const { git } = tools(mockRepo().repo);
  assert.match(await git.run({ kind: 'git_diff', path: '../secret' }), /вне проекта/);
});

test('git log: короткий хеш, дата, автор, заголовок', async () => {
  const { git } = tools(mockRepo().repo);
  assert.equal(await git.run({ kind: 'git_log', count: 5 }), 'abc1234 2026-10-01 Автор: feat: первое');
});

test('коммит: ничего не подготовлено — все изменения; без postCommitCommand; отказ — ничего не делаем', async () => {
  const { repo, calls } = mockRepo({ workingTreeChanges: [change('a.bsl', 5), change('new.bsl', 7)] });
  const denied = tools(repo, async () => false);
  assert.match(await denied.git.run({ kind: 'git_commit', message: 'fix: правка' }), /^Пользователь отклонил коммит\. Не повторяй/);
  assert.deepEqual(calls, []);

  const { git, asked } = tools(repo);
  const result = await git.run({ kind: 'git_commit', message: 'fix: правка' });
  assert.deepEqual(asked[0].details, ['fix: правка', 'Файлы (2): a.bsl, new.bsl']);
  assert.deepEqual(calls, ['add a.bsl,new.bsl', 'commit fix: правка {"postCommitCommand":null}']);
  assert.equal(result, 'Коммит создан abc1234: «fix: правка», файлов: 2.');
});

test('коммит: есть подготовленное — только оно, без git add', async () => {
  const { repo, calls } = mockRepo({ indexChanges: [change('staged.bsl', 0)], workingTreeChanges: [change('work.bsl', 5)] });
  const { git, asked } = tools(repo);
  const result = await git.run({ kind: 'git_commit', message: 'fix: правка' });
  assert.equal(asked[0].details[1], 'Файлы (1, только подготовленные): staged.bsl');
  assert.deepEqual(calls, ['commit fix: правка {"postCommitCommand":null}']);
  assert.match(result, /Не подготовленные изменения \(1\) в коммит не вошли\./);
});

test('коммит при конфликтах и без изменений — без карточки', async () => {
  const conflicted = tools(mockRepo({ mergeChanges: [change('a.bsl', 18)] }).repo);
  assert.match(await conflicted.git.run({ kind: 'git_commit', message: 'x' }), /конфликты \(a\.bsl\)/);
  assert.equal(conflicted.asked.length, 0);
  const clean = tools(mockRepo().repo);
  assert.equal(await clean.git.run({ kind: 'git_commit', message: 'x' }), 'Коммитить нечего: изменений нет.');
});

test('checkout: только существующие ветки; ветка remote — по имени без remote', async () => {
  const { repo, calls } = mockRepo();
  const { git, asked } = tools(repo);
  assert.match(await git.run({ kind: 'git_checkout', branch: 'abc1234' }), /ветки abc1234 нет/);
  assert.equal(await git.run({ kind: 'git_checkout', branch: 'main' }), 'Уже на ветке main.');
  assert.equal(asked.length, 0);
  await git.run({ kind: 'git_checkout', branch: 'origin/feature' });
  await git.run({ kind: 'git_checkout', branch: 'dev' });
  assert.deepEqual(calls, ['checkout feature', 'checkout dev']);
});

test('создание ветки: проверка имени и существования', async () => {
  const { repo, calls } = mockRepo();
  const { git } = tools(repo);
  assert.match(await git.run({ kind: 'git_create_branch', name: 'bad name' }), /недопустимое имя/);
  assert.match(await git.run({ kind: 'git_create_branch', name: 'dev' }), /уже есть/);
  assert.equal(await git.run({ kind: 'git_create_branch', name: 'feature/x' }), 'Создана ветка feature/x, текущая ветка — feature/x.');
  assert.deepEqual(calls, ['createBranch feature/x true']);
});

test('push: без upstream — в origin с созданием связи; отклонённый push — подсказка про pull', async () => {
  const { repo, calls } = mockRepo({ HEAD: { name: 'feature' } });
  const { git, asked } = tools(repo);
  assert.equal(await git.run({ kind: 'git_push' }), 'Ветка feature отправлена в origin/feature.');
  assert.match(asked[0].details.join(' '), /будет создана/);
  assert.deepEqual(calls, ['push origin feature true']);

  const main = tools(mockRepo().repo);
  await main.git.run({ kind: 'git_push' });
  assert.match(main.asked[0].details[0], /⚠️ main — основная ветка/);

  const rejected = mockRepo();
  rejected.repo.push = async () => {
    throw Object.assign(new Error('Failed to execute git'), { gitErrorCode: 'PushRejected' });
  };
  const afterReject = tools(rejected.repo);
  assert.match(await afterReject.git.run({ kind: 'git_push' }), /Pull сам не делай/);
  // Повтор в том же запросе — без карточки и без вызова git
  assert.match(await afterReject.git.run({ kind: 'git_push' }), /^Не выполнено: в этом запросе уже было «Push отклонён/);
  assert.equal(afterReject.asked.length, 1);
});

test('отказ пользователя блокирует повтор той же команды до конца запроса, другие команды — нет', async () => {
  const { repo, calls } = mockRepo({ workingTreeChanges: [change('a.bsl', 5)] });
  const { git, asked } = tools(repo, async (op) => !op.title.startsWith('Коммит'));
  await git.run({ kind: 'git_commit', message: 'fix: x' });
  assert.match(await git.run({ kind: 'git_commit', message: 'fix: y' }), /^Не выполнено: .*Пользователь отклонил коммит/);
  assert.equal(asked.length, 1);
  assert.equal(await git.run({ kind: 'git_create_branch', name: 'feature/x' }), 'Создана ветка feature/x, текущая ветка — feature/x.');
  assert.deepEqual(calls, ['createBranch feature/x true']);
});

test('push --force и pull --rebase не выполняются и не спрашивают', async () => {
  const { repo, calls } = mockRepo();
  const { git, asked } = tools(repo);
  assert.match(await git.run({ kind: 'git_push', flags: '--force' }), /git push --force недоступен/);
  assert.match(await git.run({ kind: 'git_pull', flags: '--rebase' }), /git pull --rebase недоступен/);
  assert.deepEqual([calls, asked], [[], []]);
});

test('pull с конфликтами — модели не исправлять самой', async () => {
  const { repo, state } = mockRepo();
  repo.pull = async () => {
    Object.assign(state, { mergeChanges: [change('a.bsl', 18)] });
    throw Object.assign(new Error('Failed'), { gitErrorCode: 'Conflict', stderr: 'CONFLICT (content)' });
  };
  const text = await tools(repo).git.run({ kind: 'git_pull' });
  assert.match(text, /конфликты в файлах: a\.bsl\. Не исправляй их сам/);
});

test('ошибка git — текстом из stderr', async () => {
  const { repo } = mockRepo();
  repo.log = async () => {
    throw Object.assign(new Error('Failed to execute git'), { stderr: 'fatal: bad revision\n' });
  };
  assert.equal(await tools(repo).git.run({ kind: 'git_log' }), 'Ошибка git: fatal: bad revision');
});

test('имена веток', () => {
  for (const ok of ['feature/x', 'fix-1', 'релиз/1.2']) assert.ok(isValidBranchName(ok), ok);
  for (const bad of ['-x', 'a..b', 'a b', 'x.lock', 'a/', '.x', 'a/.b', 'a~1', '@', 'a@{1}']) assert.ok(!isValidBranchName(bad), bad);
});

test('git-действие — только если о нём просили: в вопросе или в предыдущем ответе Напарника', () => {
  assert.ok(requestedByUser('git_commit', 'Закоммить мои изменения'));
  assert.ok(requestedByUser('git_commit', 'да\nЕсть незакоммиченные изменения. Закоммитить их?'));
  assert.ok(!requestedByUser('git_commit', 'Запушь мои коммиты'));
  assert.ok(!requestedByUser('git_commit', 'Покажи последние 3 коммита'));
  assert.ok(requestedByUser('git_commit', 'Сделай коммит'));
  assert.ok(requestedByUser('git_commit', 'да\nСоздать коммит с этими изменениями?'));
  assert.ok(requestedByUser('git_push', 'Отправь коммит на сервер'));
  assert.ok(!requestedByUser('git_pull', 'Запушь'));
  assert.ok(!requestedByUser('git_pull', 'Сделай популярный пример'));
  assert.ok(requestedByUser('git_pull', 'Подтяни свежие изменения'));
  assert.ok(!requestedByUser('git_create_branch', 'Переключись на ветку release'));
  assert.ok(requestedByUser('git_create_branch', 'Создай ветку feature/x'));
  assert.ok(requestedByUser('git_checkout', 'Вернись на main'));
  // Чтение и проверка без текста просьбы — всегда
  assert.ok(requestedByUser('git_status', 'что угодно'));
  assert.ok(requestedByUser('git_commit', undefined));
});

test('GitTools: действие без просьбы не выполняется и не показывает карточку', async () => {
  const { repo, calls } = mockRepo({ workingTreeChanges: [change('a.bsl', 5)] });
  const asked: GitOperation[] = [];
  const git = new GitTools(repo, ROOT, async (op) => (asked.push(op), true), undefined, undefined, 'Запушь');
  assert.match(await git.run({ kind: 'git_commit', message: 'fix: x' }), /^Не выполнено: пользователь не просил коммит/);
  assert.equal(await git.run({ kind: 'git_push' }), 'Ветка main отправлена в origin/main.');
  assert.deepEqual([asked.length, calls], [1, ['push']]);
});

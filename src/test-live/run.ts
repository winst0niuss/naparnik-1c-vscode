/**
 * Живой набор: `npm run test:live` (не входит в `npm test` и в .vsix).
 *
 * Переменные: NAPARNIK_API_TOKEN — токен (без него набор пропускается); NAPARNIK_TEST_PROJECTS — проекты через «:»;
 * NAPARNIK_LIVE_VSCODE — путь к бинарнику VS Code (по умолчанию /Applications/Visual Studio Code.app).
 * Аргументы: --project=<имя или путь> — только этот проект; --group=api,faults,security,bigdata,chat,agent,git,injection,activation;
 * --only=<часть имени сценария>; --keep — оставить копии проектов для разбора.
 *
 * Оригиналы проектов не трогаются: набор копирует каждый в /tmp/naparnik-test/<имя>, удаляет в копии git remote
 * и проверяет, что `git remote -v` пуст, до первого запроса к API. В конце сверяет git status, HEAD и stash оригиналов.
 */
import { execFileSync, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { LiveProxy } from './proxy';
import { ProxyControl, ScenarioMetric, mask, percentile, runScenarios } from './common';
import { apiScenarios, faultScenarios } from './nodeScenarios';

const DEFAULT_PROJECTS = ['/Users/user/Разработка/other/taiko_pixel', '/Users/user/Разработка/g5/g5-autotests'];
const WORK_DIR = '/tmp/naparnik-test';
const UPSTREAM = 'https://code.1c.ai';
const NODE_GROUPS = ['api', 'faults'];
const VSCODE_GROUPS = ['security', 'bigdata', 'chat', 'agent', 'git', 'injection', 'activation', 'ab-files', 'ab-init'];
// A/B-проверки промптов тратят весь бюджет запросов — только по явному --group
const DEFAULT_GROUPS = [...NODE_GROUPS, ...VSCODE_GROUPS.filter((g) => !g.startsWith('ab-'))];
const VSCODE_TIMEOUT_MS = 2 * 60 * 60 * 1000;

function arg(name: string): string | undefined {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  return a?.slice(name.length + 3);
}

const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** Состояние оригинала — сверяется до и после прогона */
function originalState(dir: string): string {
  return [`status:\n${git(dir, 'status', '--porcelain')}`, `HEAD ${git(dir, 'rev-parse', 'HEAD')}`, `branch ${git(dir, 'branch', '--show-current')}`, `stash:\n${git(dir, 'stash', 'list')}`].join('\n');
}

async function makeCopy(original: string): Promise<string> {
  const copy = path.join(WORK_DIR, path.basename(original));
  await fs.rm(copy, { recursive: true, force: true });
  await fs.mkdir(WORK_DIR, { recursive: true });
  // APFS-клон (cp -c): копия мгновенная и не занимает места, пока файлы не изменены
  try {
    execFileSync('cp', ['-cR', original, copy]);
  } catch {
    execFileSync('cp', ['-R', original, copy]);
  }
  for (const remote of git(copy, 'remote').split('\n').filter(Boolean)) git(copy, 'remote', 'remove', remote);
  if (git(copy, 'remote', '-v') !== '') throw new Error(`в копии ${copy} остались git remote — прогон остановлен до запросов к API`);
  return copy;
}

async function runVsCode(copy: string, project: string, proxyUrl: string, groups: string[], only: string | undefined): Promise<ScenarioMetric[]> {
  const bin = process.env.NAPARNIK_LIVE_VSCODE ?? '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  // Путь к user-data-dir короче 103 символов — иначе VS Code не создаёт сокет
  const userData = path.join(WORK_DIR, `ud-${Date.now() % 100000}`);
  const extDir = path.join(WORK_DIR, 'ext');
  await fs.mkdir(path.join(userData, 'User'), { recursive: true });
  await fs.mkdir(extDir, { recursive: true });
  await fs.writeFile(
    path.join(userData, 'User', 'settings.json'),
    JSON.stringify({ 'security.workspace.trust.enabled': false, 'git.autofetch': false, 'git.openRepositoryInParentFolders': 'never', 'workbench.startupEditor': 'none', 'extensions.autoUpdate': false, 'naparnik.baseUrl': proxyUrl }),
  );
  const out = path.join(WORK_DIR, `result-${project}.json`);
  await fs.rm(out, { force: true });
  const root = path.resolve(__dirname, '..', '..');
  const args = [`--user-data-dir=${userData}`, `--extensions-dir=${extDir}`, `--extensionDevelopmentPath=${root}`, `--extensionTestsPath=${path.join(__dirname, 'vscodeHost.js')}`, '--skip-welcome', '--skip-release-notes', copy];
  const env: NodeJS.ProcessEnv = { ...process.env, NAPARNIK_LIVE_PROXY: proxyUrl, NAPARNIK_LIVE_PROJECT: project, NAPARNIK_LIVE_OUT: out, NAPARNIK_LIVE_GROUPS: groups.join(','), NAPARNIK_LIVE_ONLY: only ?? '' };
  delete env.ELECTRON_RUN_AS_NODE;
  await new Promise<void>((resolve) => {
    const child = spawn(bin, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const relay = (chunk: Buffer) => {
      for (const line of mask(chunk.toString()).split('\n')) if (/^\s+[✔✘–] /.test(line)) console.log(line);
    };
    child.stdout.on('data', relay);
    child.stderr.on('data', () => undefined);
    const timer = setTimeout(() => child.kill(), VSCODE_TIMEOUT_MS);
    child.on('error', (err) => console.error(`VS Code не запустился: ${err.message}`));
    child.on('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
  await fs.rm(userData, { recursive: true, force: true });
  if (!existsSync(out)) {
    return [{ project, group: 'vscode', scenario: 'запуск VS Code', kind: 'negative', result: 'fail', totalMs: 0, sentChars: 0, sentTokensEst: 0, requests: 0, peakRssMb: 0, error: 'VS Code не записал результаты' }];
  }
  const data = JSON.parse(await fs.readFile(out, 'utf8')) as { metrics: ScenarioMetric[] };
  await fs.rm(out, { force: true });
  return data.metrics;
}

function summary(metrics: ScenarioMetric[]): string {
  const rows: string[] = [];
  const fmt = (v: number | undefined) => (v === undefined ? '—' : String(Math.round(v)));
  rows.push('| Проект | Вид | Всего | ✔ | ✘ | пропущено | TTFC p50 | TTFC p95 | Время p50 | Время p95 | Контекст, симв. (макс.) | Запросов | Память, МБ (пик) |');
  rows.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|');
  const keys = [...new Set(metrics.map((m) => `${m.project}\u0000${m.kind}`))];
  for (const key of keys) {
    const [project, kind] = key.split('\u0000');
    const list = metrics.filter((m) => m.project === project && m.kind === kind);
    const ran = list.filter((m) => m.result !== 'skip');
    const ttfc = ran.map((m) => m.ttfcMs).filter((v): v is number => v !== undefined);
    const total = ran.map((m) => m.totalMs);
    rows.push(
      `| ${project} | ${kind} | ${list.length} | ${list.filter((m) => m.result === 'pass').length} | ${list.filter((m) => m.result === 'fail').length} | ${list.filter((m) => m.result === 'skip').length} | ${fmt(percentile(ttfc, 50))} | ${fmt(percentile(ttfc, 95))} | ${fmt(percentile(total, 50))} | ${fmt(percentile(total, 95))} | ${Math.max(0, ...ran.map((m) => m.sentChars))} | ${ran.reduce((n, m) => n + m.requests, 0)} | ${Math.max(0, ...ran.map((m) => m.peakRssMb))} |`,
    );
  }
  const failed = metrics.filter((m) => m.result === 'fail');
  if (failed.length) rows.push('', 'Упало:', ...failed.map((m) => `- [${m.project}] ${m.group}/${m.scenario}: ${m.error}`));
  return rows.join('\n');
}

async function main(): Promise<void> {
  if (!process.env.NAPARNIK_API_TOKEN) {
    console.log('test:live пропущен: не задан NAPARNIK_API_TOKEN (токен 1С:Напарник). Пример: NAPARNIK_API_TOKEN=… npm run test:live');
    return;
  }
  const groups = (arg('group') ?? DEFAULT_GROUPS.join(',')).split(',');
  const only = arg('only');
  const keep = process.argv.includes('--keep');
  const projectArg = arg('project');
  let projects = (process.env.NAPARNIK_TEST_PROJECTS ? process.env.NAPARNIK_TEST_PROJECTS.split(':') : DEFAULT_PROJECTS).filter(Boolean);
  if (projectArg) projects = projects.filter((p) => p === projectArg || path.basename(p) === projectArg);

  const metrics: ScenarioMetric[] = [];
  const originals = new Map<string, string>();
  for (const p of projects) {
    if (!existsSync(p)) {
      console.log(`Проект не найден, пропущен: ${p}`);
      metrics.push({ project: path.basename(p), group: 'setup', scenario: 'проект не найден', kind: 'negative', result: 'skip', totalMs: 0, sentChars: 0, sentTokensEst: 0, requests: 0, peakRssMb: 0, error: `нет папки ${p}` });
      continue;
    }
    originals.set(p, originalState(p));
  }

  const proxy = new LiveProxy({ upstream: UPSTREAM, perMinute: 10, maxRequests: 150 });
  const proxyUrl = await proxy.start();
  const control = new ProxyControl(proxyUrl);
  const startedAt = new Date();
  try {
    const nodeGroups = groups.filter((g) => NODE_GROUPS.includes(g));
    if (nodeGroups.length) {
      const ctx = { proxy: control, project: '(без проекта)', projectCopy: '' };
      console.log('Группы без VS Code:');
      if (nodeGroups.includes('api')) metrics.push(...(await runScenarios('api', apiScenarios(proxyUrl), ctx, only)));
      if (nodeGroups.includes('faults')) metrics.push(...(await runScenarios('faults', faultScenarios(proxyUrl, (id, spec) => control.faultUrl(id, spec)), ctx, only)));
    }
    const vsGroups = groups.filter((g) => VSCODE_GROUPS.includes(g));
    for (const original of originals.keys()) {
      if (!vsGroups.length) break;
      const project = path.basename(original);
      console.log(`\nПроект ${project}: копия и VS Code…`);
      const copy = await makeCopy(original);
      try {
        metrics.push(...(await runVsCode(copy, project, proxyUrl, vsGroups, only)));
      } finally {
        if (!keep) await fs.rm(copy, { recursive: true, force: true });
      }
    }
    if (!keep) await fs.rm(path.join(WORK_DIR, 'ext'), { recursive: true, force: true });
  } finally {
    await proxy.stop();
  }

  // Оригиналы не должны измениться
  for (const [p, before] of originals) {
    const ok = originalState(p) === before;
    metrics.push({ project: path.basename(p), group: 'safety', scenario: 'оригинал не изменён (status, HEAD, ветка, stash)', kind: 'negative', result: ok ? 'pass' : 'fail', totalMs: 0, sentChars: 0, sentTokensEst: 0, requests: 0, peakRssMb: 0, error: ok ? undefined : 'состояние оригинала изменилось' });
  }

  const resultsDir = path.resolve(__dirname, '..', '..', 'test-results');
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = startedAt.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(resultsDir, `live-${stamp}.json`);
  await fs.writeFile(file, mask(JSON.stringify({ startedAt, upstreamRequests: proxy.totalRequests, metrics }, null, 2)));
  console.log(`\nЗапросов к API: ${proxy.totalRequests} из 150\n`);
  console.log(summary(metrics));
  console.log(`\nМетрики: ${path.relative(process.cwd(), file)}`);
  if (metrics.some((m) => m.result === 'fail')) process.exitCode = 1;
}

main().catch((err) => {
  console.error(mask(String(err instanceof Error ? err.stack : err)));
  process.exitCode = 1;
});

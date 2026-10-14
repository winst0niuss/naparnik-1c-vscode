/**
 * Общее для живого набора: метрики, маскирование токена, перцентили.
 * Набор не входит в `npm test` и в .vsix — запускается `npm run test:live`.
 */

export interface ScenarioMetric {
  project: string;
  group: string;
  scenario: string;
  kind: 'positive' | 'negative' | 'bigdata';
  result: 'pass' | 'fail' | 'skip';
  /** До первого символа ответа, без ожидания в лимитере набора */
  ttfcMs?: number;
  totalMs: number;
  /** Сколько символов ушло в API (тела запросов к /messages) */
  sentChars: number;
  /** Оценка токенов: код 1С ≈ 2,3 символа на токен */
  sentTokensEst: number;
  requests: number;
  peakRssMb: number;
  details?: string;
  error?: string;
}

/** Снимок счётчиков прокси для одного сценария */
export interface ProxyStats {
  requests: number;
  sentChars: number;
  queuedMs: number;
  budgetLeft: number;
  exhausted: boolean;
}

export const CHARS_PER_TOKEN = 2.3;

/** Убрать токен из любого текста перед выводом или записью */
export function mask(text: string): string {
  const token = process.env.NAPARNIK_API_TOKEN;
  if (!token || token.length < 6) return text;
  return text.split(token).join('***');
}

export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[idx];
}

/** Пиковая память процесса за время сценария */
export class RssSampler {
  private peak = process.memoryUsage().rss;
  private readonly timer = setInterval(() => (this.peak = Math.max(this.peak, process.memoryUsage().rss)), 100);

  stop(): number {
    clearInterval(this.timer);
    this.peak = Math.max(this.peak, process.memoryUsage().rss);
    return Math.round(this.peak / 1024 / 1024);
  }
}

/** Управление прокси из сценария: отметить начало и снять счётчики */
export class ProxyControl {
  constructor(readonly baseUrl: string) {}

  async begin(name: string): Promise<void> {
    await fetch(`${this.baseUrl}/__ctl/begin?name=${encodeURIComponent(name)}`, { method: 'POST' });
  }

  async stats(): Promise<ProxyStats> {
    return (await (await fetch(`${this.baseUrl}/__ctl/stats`)).json()) as ProxyStats;
  }

  /** URL API со сбоем: /__f/<id>/<спецификация> — id делает счётчик «один раз» своим для сценария */
  faultUrl(id: string, spec: string): string {
    return `${this.baseUrl}/__f/${id}/${spec}`;
  }
}

/** Ошибка проверки внутри сценария */
export function check(cond: unknown, message: string): asserts cond {
  if (!cond) throw new Error(message);
}

export interface ScenarioContext {
  proxy: ProxyControl;
  project: string;
  projectCopy: string;
}

export interface Scenario {
  name: string;
  kind: ScenarioMetric['kind'];
  /** Сценарий сам замеряет время до первого символа и возвращает его; details — для отчёта */
  run: (ctx: ScenarioContext) => Promise<{ ttfcMs?: number; details?: string } | void>;
}

/** Выполнить сценарии группы с замером и записью метрик */
// Сценарий дольше — считается зависшим: иначе один зависший запрос съедал весь прогон
const SCENARIO_TIMEOUT_MS = Number(process.env.NAPARNIK_LIVE_SCENARIO_TIMEOUT_MS || 20 * 60 * 1000);

export async function runScenarios(
  group: string,
  scenarios: Scenario[],
  ctx: ScenarioContext,
  only?: string,
  onMetric?: (m: ScenarioMetric) => Promise<void>,
): Promise<ScenarioMetric[]> {
  const metrics: ScenarioMetric[] = [];
  for (const s of scenarios) {
    if (only && !s.name.includes(only)) continue;
    const before = await ctx.proxy.stats();
    if (before.exhausted) {
      metrics.push({ project: ctx.project, group, scenario: s.name, kind: s.kind, result: 'skip', totalMs: 0, sentChars: 0, sentTokensEst: 0, requests: 0, peakRssMb: 0, error: 'лимит запросов набора исчерпан' });
      continue;
    }
    await ctx.proxy.begin(`${group}/${s.name}`);
    const sampler = new RssSampler();
    const start = Date.now();
    let result: ScenarioMetric['result'] = 'pass';
    let error: string | undefined;
    let out: { ttfcMs?: number; details?: string } | void = undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`сценарий завис: нет результата за ${Math.round(SCENARIO_TIMEOUT_MS / 60000)} мин`)), SCENARIO_TIMEOUT_MS);
      });
      out = await Promise.race([s.run(ctx), timeout]);
    } catch (err) {
      result = 'fail';
      error = mask(err instanceof Error ? `${err.message}${err.cause instanceof Error ? `: ${err.cause.message}` : ''}` : String(err));
    }
    clearTimeout(timer);
    const totalMs = Date.now() - start;
    const after = await ctx.proxy.stats();
    const queued = after.queuedMs - before.queuedMs;
    const sentChars = after.sentChars - before.sentChars;
    if (after.exhausted && result === 'fail' && !before.exhausted) error = `${error} (лимит запросов набора исчерпан)`;
    const m: ScenarioMetric = {
      project: ctx.project,
      group,
      scenario: s.name,
      kind: s.kind,
      result,
      ttfcMs: out?.ttfcMs === undefined ? undefined : Math.max(0, out.ttfcMs - queued),
      totalMs: Math.max(0, totalMs - queued),
      sentChars,
      sentTokensEst: Math.round(sentChars / CHARS_PER_TOKEN),
      requests: after.requests - before.requests,
      peakRssMb: sampler.stop(),
      details: out?.details && mask(out.details),
      error,
    };
    metrics.push(m);
    await onMetric?.(m);
    const mark = result === 'pass' ? '✔' : '✘';
    console.log(`  ${mark} ${group}/${s.name} · ${m.totalMs} мс · запросов ${m.requests}${error ? ` · ${error}` : ''}`);
  }
  return metrics;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

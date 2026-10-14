/**
 * Локальный прокси к живому API для набора test:live.
 * — Весь трафик набора идёт через него: считает запросы и объём, держит лимит 10 запросов в минуту
 *   и 150 на прогон (дальше отвечает 418 и помечает бюджет исчерпанным).
 * — /__f/<id>/<спецификация>/… — сбои, которых живой API сам не выдаст. Спецификации:
 *   s<код>[ra<сек>]x<N|inf> — вместо ответа /messages отдать код (с Retry-After), N раз или всегда;
 *   resetx<N> — оборвать соединение до ответа; cut<N> — переслать N строк data: и оборвать сокет;
 *   end<N> — после N строк data: аккуратно закрыть поток (без finished); stall<мс> — после первой строки data: замолчать;
 *   hb<мс> — то же, но слать «: heartbeat» раз в секунду; split — резать каждый кусок посреди многобайтовых символов.
 *   Сбои применяются только к POST …/messages; создание дискуссии проходит как есть.
 */
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

const WINDOW_MS = 60_000;

export interface LiveProxyOptions {
  upstream: string;
  perMinute: number;
  maxRequests: number;
}

export class LiveProxy {
  private server: http.Server | undefined;
  private readonly sent: number[] = []; // время отправки запросов вверх — для лимита в минуту
  private requests = 0;
  private sentChars = 0;
  private queuedMs = 0;
  private exhausted = false;
  private readonly faultCounters = new Map<string, number>();
  private readonly sockets = new Set<import('node:net').Socket>();
  scenario = '';

  constructor(private readonly opts: LiveProxyOptions) {}

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => void this.handle(req, res).catch(() => res.destroy()));
    this.server.on('connection', (s) => {
      this.sockets.add(s);
      s.on('close', () => this.sockets.delete(s));
    });
    await new Promise<void>((r) => this.server!.listen(0, '127.0.0.1', r));
    return `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.sockets.forEach((s) => s.destroy());
    await new Promise<void>((r) => this.server?.close(() => r()) ?? r());
  }

  get totalRequests(): number {
    return this.requests;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://x');
    if (url.pathname === '/__ctl/begin') {
      this.scenario = url.searchParams.get('name') ?? '';
      res.end('ok');
      return;
    }
    if (url.pathname === '/__ctl/stats') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ requests: this.requests, sentChars: this.sentChars, queuedMs: this.queuedMs, budgetLeft: this.opts.maxRequests - this.requests, exhausted: this.exhausted }));
      return;
    }

    let path = url.pathname;
    let fault: { id: string; spec: string } | undefined;
    const m = path.match(/^\/__f\/([^/]+)\/([^/]+)(\/.*)$/);
    if (m) {
      fault = { id: m[1], spec: m[2] };
      path = m[3];
    }
    const body = await readBody(req);
    const isMessage = req.method === 'POST' && /\/messages$/.test(path);

    if (fault && isMessage) {
      const handled = this.preFault(fault, res, req);
      if (handled) return;
    }

    if (this.requests >= this.opts.maxRequests) {
      this.exhausted = true;
      res.writeHead(418, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ detail: `Лимит набора: ${this.opts.maxRequests} запросов на прогон исчерпан` }));
      return;
    }
    await this.waitForSlot();
    this.requests++;
    if (isMessage) this.sentChars += countInstructionChars(body);

    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string' && !['host', 'connection', 'content-length', 'accept-encoding'].includes(k)) headers[k] = v;
    }
    const controller = new AbortController();
    res.on('close', () => controller.abort());
    let upstream: Response;
    try {
      upstream = await fetch(this.opts.upstream + path + url.search, { method: req.method, headers, body: body.length ? new Uint8Array(body) : undefined, signal: controller.signal });
    } catch (err) {
      if (!controller.signal.aborted) logUpstreamError(`запрос ${path}`, err);
      res.destroy();
      return;
    }
    const outHeaders: Record<string, string> = {};
    upstream.headers.forEach((v, k) => {
      if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) outHeaders[k] = v;
    });
    res.writeHead(upstream.status, outHeaders);
    if (!upstream.body) {
      res.end();
      return;
    }
    await this.pipe(upstream.body, res, isMessage ? fault : undefined, controller);
  }

  /** Сбой до запроса к API; true — ответ уже отдан */
  private preFault(fault: { id: string; spec: string }, res: http.ServerResponse, req: http.IncomingMessage): boolean {
    const once = fault.spec.match(/^(s(\d{3})(?:ra(\d+))?|reset)x(\d+|inf)$/);
    if (!once) return false;
    const key = `${fault.id}/${fault.spec}`;
    const used = this.faultCounters.get(key) ?? 0;
    const limit = once[4] === 'inf' ? Infinity : Number(once[4]);
    if (used >= limit) return false;
    this.faultCounters.set(key, used + 1);
    if (once[1] === 'reset') {
      req.socket.destroy();
      return true;
    }
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (once[3]) headers['Retry-After'] = once[3];
    res.writeHead(Number(once[2]), headers);
    res.end(JSON.stringify({ detail: `test fault ${once[2]}` }));
    return true;
  }

  private async pipe(body: ReadableStream<Uint8Array>, res: http.ServerResponse, fault: { id: string; spec: string } | undefined, controller: AbortController): Promise<void> {
    const spec = fault?.spec ?? '';
    const cut = spec.match(/^cut(\d+)$/);
    const end = spec.match(/^end(\d+)$/);
    const stall = spec.match(/^(stall|hb)(\d+)$/);
    const split = spec === 'split';
    let dataLines = 0;
    let stalled = false;
    let pending = '';
    const decoder = new TextDecoder();
    try {
      for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
        if (!cut && !end && !stall) {
          await writeChunk(res, chunk, split);
          continue;
        }
        // Режем по строкам, чтобы считать события data:
        pending += decoder.decode(chunk, { stream: true });
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          await writeChunk(res, Buffer.from(line + '\n'), false);
          if (!line.startsWith('data: ')) continue;
          dataLines++;
          if (cut && dataLines >= Number(cut[1])) {
            controller.abort();
            res.destroy();
            return;
          }
          if (end && dataLines >= Number(end[1])) {
            controller.abort();
            res.end();
            return;
          }
          if (stall && !stalled) {
            stalled = true;
            const until = Date.now() + Number(stall[2]);
            while (Date.now() < until && !res.destroyed) {
              await new Promise((r) => setTimeout(r, Math.min(1000, until - Date.now())));
              if (stall[1] === 'hb' && !res.destroyed) res.write(': heartbeat\n\n');
            }
            if (res.destroyed) {
              controller.abort();
              return;
            }
          }
        }
      }
      if (pending) res.write(pending);
      res.end();
    } catch (err) {
      if (!controller.signal.aborted) logUpstreamError('поток ответа', err);
      res.destroy();
    }
  }

  /** Не больше perMinute запросов за скользящую минуту */
  private async waitForSlot(): Promise<void> {
    const started = Date.now();
    for (;;) {
      const now = Date.now();
      while (this.sent.length && now - this.sent[0] >= WINDOW_MS) this.sent.shift();
      if (this.sent.length < this.opts.perMinute) break;
      await new Promise((r) => setTimeout(r, WINDOW_MS - (now - this.sent[0]) + 50));
    }
    this.sent.push(Date.now());
    this.queuedMs += Date.now() - started;
  }
}

async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

/** Объём текста, ушедшего модели: instruction сообщения пользователя или content ответов инструментам */
function countInstructionChars(body: Buffer): number {
  try {
    const data = JSON.parse(body.toString('utf8'));
    const content = data?.content;
    if (Array.isArray(content)) return content.reduce((n: number, c: { content?: unknown }) => n + (typeof c?.content === 'string' ? c.content.length : 0), 0);
    const instruction = content?.content?.instruction;
    return typeof instruction === 'string' ? instruction.length : 0;
  } catch {
    return 0;
  }
}

/** split — отдать кусок частями, разрезая посреди многобайтовых символов UTF-8 */
async function writeChunk(res: http.ServerResponse, chunk: Uint8Array, split: boolean): Promise<void> {
  if (!split) {
    res.write(chunk);
    return;
  }
  // Ищем начало многобайтового символа и режем на байт позже — посреди символа
  let start = 0;
  for (let i = 0; i < chunk.length; i++) {
    if (chunk[i] >= 0xc0 && i + 1 < chunk.length) {
      res.write(chunk.subarray(start, i + 1));
      start = i + 1;
      // Даём сокету отправить кусок отдельно
      await new Promise((r) => setImmediate(r));
    }
  }
  if (start < chunk.length) res.write(chunk.subarray(start));
}

/** Сбой на стороне API (не остановка клиентом) — в вывод прогона: иначе обрыв у клиента не отличить от сбоя прокси */
function logUpstreamError(where: string, err: unknown): void {
  const e = err as { message?: string; cause?: { code?: string; message?: string } };
  console.log(`  ⚠ proxy: ${where} — ${e?.message ?? String(err)}${e?.cause ? ` (${e.cause.code ?? ''} ${e.cause.message ?? ''})` : ''}`);
}

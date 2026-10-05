import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { createServer, IncomingMessage, Server } from 'node:http';
import { AddressInfo } from 'node:net';
import { NaparnikClient, findTokenProblem } from '../api/client';

// Мок code.1c.ai: на каждый запрос отвечает функцией handler
async function startMock(handler: (path: string, body: any, req: IncomingMessage) => { status?: number; sse?: object[]; json?: object }) {
  const requests: { path: string; body: any; auth?: string }[] = [];
  const server: Server = createServer(async (req, res) => {
    let raw = '';
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : undefined;
    requests.push({ path: req.url ?? '', body, auth: req.headers.authorization });
    const reply = handler(req.url ?? '', body, req);
    res.statusCode = reply.status ?? 200;
    if (reply.sse) {
      res.setHeader('Content-Type', 'text/event-stream');
      for (const event of reply.sse) res.write(`data: ${JSON.stringify(event)}\n\n`);
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.write(JSON.stringify(reply.json ?? {}));
    }
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new NaparnikClient({
    token: 'secret',
    baseUrl: `http://127.0.0.1:${port}`,
    authFormat: 'plain',
    skillName: 'custom',
    timeoutMs: 5000,
  });
  return { client, requests, close: () => server.close() };
}

test('полный цикл: дискуссия → tool_calls → ACK → ответ', async () => {
  let messageCalls = 0;
  const mock = await startMock((path) => {
    if (path.endsWith('/conversations/')) return { json: { uuid: 'conv-1' } };
    messageCalls++;
    if (messageCalls === 1) {
      return {
        sse: [
          { role: 'user', finished: true },
          { role: 'assistant', uuid: 'asst-1', content: { tool_calls: [{ id: 'call-1', function: { name: 'mcp__knowledge-hub__Search_ITS' } }] }, finished: true },
        ],
      };
    }
    return { sse: [{ role: 'assistant', uuid: 'asst-2', content_delta: 'Ответ ' }, { content_delta: 'из ИТС' }, { role: 'assistant', finished: true }] };
  });

  try {
    const partials: string[] = [];
    const tools: string[][] = [];
    const id = await mock.client.createConversation();
    const answer = await mock.client.sendMessage(id, 'Вопрос', undefined, {
      onText: (t) => partials.push(t),
      onToolCalls: (names) => tools.push(names),
    });

    assert.equal(id, 'conv-1');
    assert.equal(answer.text, 'Ответ из ИТС');
    assert.equal(answer.assistantUuid, 'asst-2');
    assert.deepEqual(tools, [['mcp__knowledge-hub__Search_ITS']]);
    assert.ok(partials.includes('Ответ из ИТС'));

    // content — объект, не массив (иначе 422)
    const [create, first, ack] = mock.requests;
    assert.equal(create.auth, 'secret');
    assert.equal(first.body.parent_uuid, null);
    assert.deepEqual(first.body.content, { content: { instruction: 'Вопрос' } });
    assert.deepEqual(ack.body, {
      parent_uuid: 'asst-1',
      role: 'tool',
      content: [{ tool_call_id: 'call-1', status: 'accepted', content: null }],
    });
  } finally {
    mock.close();
  }
});

test('401 превращается в понятную ошибку про токен', async () => {
  const mock = await startMock(() => ({ status: 401, json: { detail: 'unauthorized' } }));
  try {
    await assert.rejects(mock.client.createConversation(), /Токен не принят/);
  } finally {
    mock.close();
  }
});

test('токен с кириллицей или пробелом отклоняется понятной ошибкой', () => {
  assert.equal(findTokenProblem('AbCdEfGhIjKlMnOpQrStUvWxYz12'), undefined);
  // «Р» (код 1056) — русская раскладка, как в исходной ошибке ByteString
  assert.match(findTokenProblem('AbCdEfGhIjKlMnOpQrStUvWxYzР') ?? '', /символ «Р» \(позиция 27\).*русской раскладке/);
  assert.match(findTokenProblem('abc def') ?? '', /пробел/);
  assert.throws(
    () => new NaparnikClient({ token: 'токен', baseUrl: 'http://x', authFormat: 'plain', skillName: 'raw', timeoutMs: 1 }),
    /Задать токен/,
  );
});

test('параллельные запросы в разные дискуссии не смешиваются', async () => {
  // Сервер отвечает с задержкой: первый запрос завершается позже второго
  const server = createServer(async (req, res) => {
    for await (const _ of req);
    const conv = (req.url ?? '').includes('conv-A') ? 'A' : 'B';
    res.setHeader('Content-Type', 'text/event-stream');
    for (let i = 1; i <= 3; i++) {
      await new Promise((r) => setTimeout(r, conv === 'A' ? 30 : 10));
      res.write(`data: ${JSON.stringify({ role: 'assistant', uuid: `uuid-${conv}`, content_delta: `${conv}${i} ` })}\n\n`);
    }
    res.end(`data: ${JSON.stringify({ role: 'assistant', uuid: `uuid-${conv}`, finished: true })}\n\n`);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  const client = new NaparnikClient({ token: 't', baseUrl: `http://127.0.0.1:${port}`, authFormat: 'plain', skillName: 'raw', timeoutMs: 5000 });

  try {
    const partialsA: string[] = [];
    const partialsB: string[] = [];
    const [a, b] = await Promise.all([
      client.sendMessage('conv-A', 'вопрос A', undefined, { onText: (t) => partialsA.push(t) }),
      client.sendMessage('conv-B', 'вопрос B', undefined, { onText: (t) => partialsB.push(t) }),
    ]);
    assert.deepEqual(a, { text: 'A1 A2 A3', assistantUuid: 'uuid-A' });
    assert.deepEqual(b, { text: 'B1 B2 B3', assistantUuid: 'uuid-B' });
    assert.ok(partialsA.every((t) => !t.includes('B')));
    assert.ok(partialsB.every((t) => !t.includes('A')));
  } finally {
    server.close();
  }
});

test('инструменты 1С:EDT отклоняются с пояснением, поиск по ИТС подтверждается', async () => {
  let calls = 0;
  const mock = await startMock(() => {
    calls++;
    if (calls === 1) {
      return {
        sse: [
          {
            role: 'assistant',
            uuid: 'asst-1',
            content: {
              tool_calls: [
                { id: 'c-its', function: { name: 'mcp__knowledge-hub__Search_ITS' } },
                { id: 'c-edt', function: { name: 'WriteSystemFile' } },
              ],
            },
            finished: true,
          },
        ],
      };
    }
    return { sse: [{ role: 'assistant', uuid: 'asst-2', content: { content: 'готово' }, finished: true }] };
  });
  try {
    const tools: string[][] = [];
    const answer = await mock.client.sendMessage('conv', 'вопрос', undefined, {
      onText: () => {},
      onToolCalls: (n) => tools.push(n),
      unavailableToolHint: 'используй @create_file',
    });
    assert.equal(answer.text, 'готово');
    assert.deepEqual(tools, [['mcp__knowledge-hub__Search_ITS']]);
    assert.deepEqual(mock.requests[1].body.content, [
      { tool_call_id: 'c-its', status: 'accepted', content: null },
      { tool_call_id: 'c-edt', status: 'rejected', content: 'используй @create_file' },
    ]);
  } finally {
    mock.close();
  }
});

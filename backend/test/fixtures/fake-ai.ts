/**
 * 假 AI 主機(AGENT.md §9:測試不連 10.10.130.46):vLLM(OpenAI 相容)、embedding、Qdrant;記錄每個請求
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

/* ───────── 假 AI 主機:vLLM(OpenAI 相容)、embedding、Qdrant ───────── */

export interface Req {
  method: string;
  url: string;
  headers: http.IncomingHttpHeaders;
  body: any;
}
/**
 * opts.streamDelayMs:串流回答開始前等多久(測試同時上限用)
 */
export function fakeAiHost(opts: { streamDelayMs?: number } = {}) {
  const reqs: Req[] = [];
  const points = new Map<string, { id: string; payload: Record<string, unknown> }>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      reqs.push({ method: req.method!, url: req.url!, headers: req.headers, body });
      const json = (v: unknown) => res.setHeader('content-type', 'application/json').end(JSON.stringify(v));
      const u = req.url!;
      if (u === '/v1/models') return json({ data: [{ id: 'fake-model' }] });
      if (u === '/v1/embeddings') {
        const s = String(body.input);
        return json({ data: [{ embedding: [s.length, ...[...s].slice(0, 3).map((c) => c.charCodeAt(0))] }] });
      }
      if (u === '/v1/chat/completions') {
        const last = body.messages.at(-1).content as string;
        if (!body.stream) return json({ choices: [{ message: { content: `ok:${last.slice(0, 30)}` } }] });
        res.setHeader('content-type', 'text/event-stream');
        const lines = [
          ...Array.from({ length: body.chat_template_kwargs.enable_thinking ? 5 : 0 }, () => ({ choices: [{ delta: { reasoning: 'r'.repeat(90) } }] })),
          { choices: [{ delta: { reasoning_content: 'x'.repeat(30), content: '## 整體結論\n' } }] },
          { choices: [{ delta: { content: '🟢 正常' } }] },
          'not json',
          { choices: [{ delta: {}, finish_reason: 'length' }] },
        ];
        // 故意切在一行中間,確認緩衝處理相同
        const all = lines.map((l) => `data: ${typeof l === 'string' ? l : JSON.stringify(l)}\n\n`).join('') + 'data: [DONE]\n\n';
        setTimeout(() => {
          res.write(all.slice(0, 37));
          setTimeout(() => res.end(all.slice(37)), 5);
        }, opts.streamDelayMs ?? 0);
        return;
      }
      const m = /^\/collections\/NetOpsKb(.*)$/.exec(u);
      if (!m) return res.writeHead(404).end('no');
      const p = m[1];
      if (p === '/points/scroll') return json({ result: { points: [...points.values()].map((x) => ({ id: x.id, payload: { noteId: x.payload.noteId, hash: x.payload.hash } })), next_page_offset: null } });
      if (p === '/points?wait=true') {
        for (const x of body.points) points.set(x.id, x);
        return json({ result: { status: 'ok' } });
      }
      if (p === '/points/delete?wait=true') {
        for (const id of body.points) points.delete(id);
        return json({ result: { status: 'ok' } });
      }
      if (p === '') return json({ result: { points_count: points.size } });
      if (p === '/points/query') return json({ result: { points: [{ id: 'x', score: 0.71234, payload: { noteId: '202611011030-a1b2c3', title: 'FTP 伺服器' } }] } });
      return res.writeHead(404).end('no');
    });
  });
  return {
    reqs,
    points,
    setStreamDelay: (ms: number) => void (opts.streamDelayMs = ms),
    async start() {
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    close: () => server.close(),
  };
}


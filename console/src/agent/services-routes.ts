// 外部服务商管理接口(挂在 /api/service-providers):联网搜索与文生图。

import { randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run, tx } from '../db.ts';
import { SEARCH_PROVIDERS } from './search/providers.ts';
import { maskConfig, serviceById } from './services.ts';
import type { AgentDeps } from './types.ts';

/** 各服务商的表单字段(与模型页的 ProviderDef 同形状) */
export const SERVICE_CATALOG = {
  search: [
    {
      provider: 'deepseek',
      label: 'DeepSeek 官方联网搜索',
      note: '用 DeepSeek 的 Anthropic 兼容接口里的 web_search 服务端工具搜索,DeepSeek 官方 API Key 即可,每次搜索按一次模型调用计费。可以直接沿用「模型」页里 DeepSeek 对话模型的密钥。',
      fields: [
        { key: 'key_from_model', label: '沿用哪个模型的密钥', type: 'model', hint: '选了就不用再填 API Key' },
        { key: 'api_key', label: 'DeepSeek API Key', type: 'password' },
        { key: 'base_url', label: '接口地址', type: 'string', default: 'https://api.deepseek.com' },
        { key: 'model', label: '搜索用的模型', type: 'string', default: 'deepseek-flash' },
        { key: 'max_uses', label: '每次最多搜几轮', type: 'number', default: 3 },
      ],
    },
    {
      provider: 'bocha',
      label: '博查 Web Search',
      note: '国内直连,中文结果好,按次计费。',
      fields: [
        { key: 'api_key', label: '博查 API Key', type: 'password', required: true },
        { key: 'count', label: '返回条数', type: 'number', default: 6 },
      ],
    },
    {
      provider: 'tavily',
      label: 'Tavily',
      note: '服务在海外,国内服务器可能需要代理。',
      fields: [
        { key: 'api_key', label: 'Tavily API Key', type: 'password', required: true },
        { key: 'max_results', label: '返回条数', type: 'number', default: 5 },
      ],
    },
  ],
  image: [] as { provider: string; label: string; note: string; fields: unknown[] }[],
};

const schema = z.object({
  kind: z.enum(['search', 'image']),
  name: z.string().min(1).max(64),
  provider: z.string().min(1).max(64),
  config: z.record(z.string(), z.unknown()).default({}),
  enabled: z.boolean().default(true),
});

export function serviceRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  app.get('/catalog', (c) => c.json(SERVICE_CATALOG));

  app.get('/', (c) => c.json({
    items: all<{ id: string; kind: string; name: string; provider: string; config_json: string; is_default: number; enabled: number }>(
      conn, 'SELECT * FROM service_providers ORDER BY kind, is_default DESC, created_at',
    ).map((row) => ({ ...row, config: maskConfig(JSON.parse(row.config_json) as Record<string, unknown>), config_json: undefined })),
  }));

  const known = (kind: 'search' | 'image', provider: string) => SERVICE_CATALOG[kind].some((item) => item.provider === provider);

  app.post('/', async (c) => {
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    if (!known(d.kind, d.provider)) return c.json({ error: `不认识的服务商 ${d.provider}` }, 400);
    const id = `svc_${randomBytes(4).toString('hex')}`;
    const first = !one(conn, 'SELECT 1 FROM service_providers WHERE kind = ?', d.kind);
    run(conn, 'INSERT INTO service_providers (id, kind, name, provider, config_json, is_default, enabled) VALUES (?, ?, ?, ?, ?, ?, ?)',
      id, d.kind, d.name, d.provider, JSON.stringify(d.config), first ? 1 : 0, d.enabled ? 1 : 0);
    return c.json({ ok: true, id });
  });

  app.put('/:id', async (c) => {
    const row = one<{ config_json: string; kind: string }>(conn, 'SELECT config_json, kind FROM service_providers WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    const parsed = schema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message ?? '参数不正确' }, 400);
    const d = parsed.data;
    if (!known(d.kind, d.provider)) return c.json({ error: `不认识的服务商 ${d.provider}` }, 400);
    // 打码的密钥原样提交回来时不覆盖
    const previous = JSON.parse(row.config_json) as Record<string, unknown>;
    const config = { ...d.config };
    for (const [key, value] of Object.entries(config)) {
      if (typeof value === 'string' && value.includes('…') && typeof previous[key] === 'string') config[key] = previous[key];
    }
    run(conn, "UPDATE service_providers SET name = ?, provider = ?, config_json = ?, enabled = ?, updated_at = datetime('now') WHERE id = ?",
      d.name, d.provider, JSON.stringify(config), d.enabled ? 1 : 0, c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/:id/default', (c) => {
    const row = one<{ kind: string }>(conn, 'SELECT kind FROM service_providers WHERE id = ?', c.req.param('id'));
    if (!row) return c.json({ error: '不存在' }, 404);
    tx(conn, () => {
      run(conn, 'UPDATE service_providers SET is_default = 0 WHERE kind = ?', row.kind);
      run(conn, 'UPDATE service_providers SET is_default = 1 WHERE id = ?', c.req.param('id'));
    });
    return c.json({ ok: true });
  });

  app.delete('/:id', (c) => {
    run(conn, 'DELETE FROM service_providers WHERE id = ?', c.req.param('id'));
    return c.json({ ok: true });
  });

  /** 测试:搜索服务搜一次 */
  app.post('/:id/test', async (c) => {
    const service = serviceById(conn, c.req.param('id'));
    if (!service) return c.json({ error: '不存在' }, 404);
    if (service.kind === 'search') {
      const provider = SEARCH_PROVIDERS[service.provider];
      if (!provider) return c.json({ error: '不认识的服务商' }, 400);
      try {
        const started = Date.now();
        const outcome = await provider(deps.fetch, service.config, '今天的科技新闻');
        return c.json({ ok: true, ms: Date.now() - started, count: outcome.results.length, sample: outcome.results.slice(0, 3), summary: outcome.summary ?? null });
      } catch (error) {
        return c.json({ error: (error as Error).message }, 502);
      }
    }
    const test = IMAGE_TESTERS[service.provider];
    if (!test) return c.json({ error: '这个服务商不支持测试' }, 400);
    try {
      return c.json(await test(deps, service.config));
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  return app;
}

/** 文生图服务商的测试函数(P5 登记) */
export const IMAGE_TESTERS: Record<string, (deps: AgentDeps, config: Record<string, unknown>) => Promise<Record<string, unknown>>> = {};

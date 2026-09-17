// 技能管理接口(挂在 /api/skills)与智能体的技能开关(/api/agents/:id/skills)。
// 技能没有全局启用开关:哪个智能体用哪些技能只在智能体页决定。

import { Hono } from 'hono';
import { z } from 'zod';
import { all, one, run, tx } from '../../db.ts';
import type { AgentDeps } from '../types.ts';
import { packageFromMarkdown, packageFromZip, parseSkillMarkdown, SkillError, type SkillPackage } from './parse.ts';

const MAX_UPLOAD = 1024 * 1024;

export function skillRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;

  app.get('/', (c) => c.json({
    items: all<Record<string, unknown>>(conn,
      `SELECT name, description, body, files_json, allowed_tools, source, updated_at FROM skills ORDER BY source DESC, name`).map((row) => ({
      ...row,
      files: Object.keys(JSON.parse(String(row['files_json'] ?? '{}')) as Record<string, string>),
      files_json: undefined,
      agents: all<{ id: string; name: string }>(conn,
        'SELECT g.id, g.name FROM agent_skills a JOIN agents g ON g.id = a.agent_id WHERE a.skill_name = ? ORDER BY g.is_default DESC, g.created_at', row['name']),
    })),
  }));

  const save = (pkg: SkillPackage, replace: boolean) => {
    const exists = one<{ source: string }>(conn, 'SELECT source FROM skills WHERE name = ?', pkg.name);
    if (exists && !replace) throw new SkillError(`已经有名为 ${pkg.name} 的技能;要覆盖请勾选「覆盖同名技能」`);
    run(conn,
      `INSERT INTO skills (name, description, body, files_json, allowed_tools, source, enabled, updated_at)
       VALUES (?, ?, ?, ?, ?, 'custom', 1, datetime('now'))
       ON CONFLICT (name) DO UPDATE SET description = excluded.description, body = excluded.body, files_json = excluded.files_json,
         allowed_tools = excluded.allowed_tools, updated_at = datetime('now')`,
      pkg.name, pkg.description, pkg.body, JSON.stringify(pkg.files), pkg.allowedTools.join(', '));
  };

  /** 导入:JSON {markdown, replace} 或原始 zip 字节(?replace=1) */
  app.post('/import', async (c) => {
    try {
      const type = (c.req.header('content-type') ?? '').split(';')[0]!.trim();
      let pkg: SkillPackage;
      let replace = false;
      if (type === 'application/json') {
        const body = z.object({ markdown: z.string().min(1).max(MAX_UPLOAD), replace: z.boolean().default(false) })
          .safeParse(await c.req.json().catch(() => ({})));
        if (!body.success) return c.json({ error: '请提供 SKILL.md 内容' }, 400);
        pkg = packageFromMarkdown(body.data.markdown);
        replace = body.data.replace;
      } else {
        if (Number(c.req.header('content-length') ?? '0') > MAX_UPLOAD) return c.json({ error: '技能包不能超过 1 MB' }, 413);
        const bytes = Buffer.from(await c.req.arrayBuffer());
        if (bytes.length > MAX_UPLOAD) return c.json({ error: '技能包不能超过 1 MB' }, 413);
        pkg = bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04]))
          ? packageFromZip(bytes)
          : packageFromMarkdown(bytes.toString('utf8'));
        replace = c.req.query('replace') === '1';
      }
      save(pkg, replace);
      return c.json({ ok: true, name: pkg.name, files: Object.keys(pkg.files), skipped: pkg.skipped });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  /** 在页面上编辑:提交完整的 SKILL.md 文字(名字不允许改) */
  app.put('/:name', async (c) => {
    const name = c.req.param('name');
    const row = one<{ files_json: string }>(conn, 'SELECT files_json FROM skills WHERE name = ?', name);
    if (!row) return c.json({ error: '技能不存在' }, 404);
    const body = z.object({ markdown: z.string().min(1).max(MAX_UPLOAD) })
      .safeParse(await c.req.json().catch(() => ({})));
    if (!body.success) return c.json({ error: '请提供 SKILL.md 内容' }, 400);
    try {
      const parsed = parseSkillMarkdown(body.data.markdown);
      if (parsed.name !== name) return c.json({ error: '不能修改技能名;要改名请导入一个新技能' }, 400);
      run(conn, "UPDATE skills SET description = ?, body = ?, allowed_tools = ?, updated_at = datetime('now') WHERE name = ?",
        parsed.description, parsed.body, parsed.allowedTools.join(', '), name);
      return c.json({ ok: true });
    } catch (error) {
      return c.json({ error: (error as Error).message }, 400);
    }
  });

  app.delete('/:name', (c) => {
    run(conn, 'DELETE FROM skills WHERE name = ?', c.req.param('name'));
    return c.json({ ok: true });
  });

  return app;
}

export function agentSkillRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  app.get('/:id/skills', (c) => c.json({
    items: all<{ skill_name: string }>(deps.conn, 'SELECT skill_name FROM agent_skills WHERE agent_id = ?', c.req.param('id')).map((r) => r.skill_name),
  }));
  app.put('/:id/skills', async (c) => {
    const id = c.req.param('id');
    if (!one(deps.conn, 'SELECT 1 FROM agents WHERE id = ?', id)) return c.json({ error: '智能体不存在' }, 404);
    const parsed = z.array(z.string().min(1).max(64)).max(100).safeParse(await c.req.json().catch(() => []));
    if (!parsed.success) return c.json({ error: '参数格式不正确' }, 400);
    for (const name of parsed.data) {
      if (!one(deps.conn, 'SELECT 1 FROM skills WHERE name = ?', name)) return c.json({ error: `没有名为 ${name} 的技能` }, 400);
    }
    tx(deps.conn, () => {
      run(deps.conn, 'DELETE FROM agent_skills WHERE agent_id = ?', id);
      for (const name of new Set(parsed.data)) run(deps.conn, 'INSERT INTO agent_skills (agent_id, skill_name) VALUES (?, ?)', id, name);
    });
    return c.json({ ok: true });
  });
  return app;
}

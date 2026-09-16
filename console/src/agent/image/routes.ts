// 画廊接口(挂在 /api/images):列表、原图、像素预览、重新发到设备、删除。

import { existsSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { Hono } from 'hono';
import { all, one, run } from '../../db.ts';
import type { AgentDeps } from '../types.ts';
import { imageMessages, type Color } from './pixel.ts';

interface ImageRow {
  id: number;
  mac: string | null;
  agent_id: string | null;
  prompt: string;
  provider: string;
  model: string;
  ext: 'png' | 'jpg';
  palette_json: string;
  created_at: string;
}

export function imageRoutes(deps: AgentDeps): Hono {
  const app = new Hono({ strict: false });
  const { conn } = deps;
  const dir = () => join(deps.dataDir(), 'images');

  app.get('/', (c) => c.json({
    items: all<ImageRow & { alias: string | null; agent_name: string | null }>(conn,
      `SELECT i.*, d.alias, a.name AS agent_name FROM images i LEFT JOIN devices d ON d.mac = i.mac LEFT JOIN agents a ON a.id = i.agent_id
       ORDER BY i.id DESC LIMIT 200`).map((row) => ({ ...row, palette_json: undefined })),
  }));

  const file = (id: string, suffix: string, type: string) => {
    const path = join(dir(), `${Number(id)}${suffix}`);
    if (!existsSync(path)) return new Response('not found', { status: 404 });
    return new Response(readFileSync(path), { headers: { 'Content-Type': type, 'Cache-Control': 'private, max-age=86400' } });
  };

  app.get('/:id/original', (c) => {
    const row = one<ImageRow>(conn, 'SELECT * FROM images WHERE id = ?', Number(c.req.param('id')));
    if (!row) return c.json({ error: '不存在' }, 404);
    return file(c.req.param('id'), `.${row.ext}`, row.ext === 'jpg' ? 'image/jpeg' : 'image/png');
  });

  app.get('/:id/pixel', (c) => file(c.req.param('id'), '.pixel.png', 'image/png'));

  /** 重新发到一台在线设备的屏幕上 */
  app.post('/:id/send', async (c) => {
    const row = one<ImageRow>(conn, 'SELECT * FROM images WHERE id = ?', Number(c.req.param('id')));
    if (!row) return c.json({ error: '不存在' }, 404);
    const body = (await c.req.json().catch(() => ({}))) as { mac?: string };
    const mac = body.mac || row.mac;
    if (!mac) return c.json({ error: '请指定设备' }, 400);
    const packedPath = join(dir(), `${row.id}.pixel.bin`);
    if (!existsSync(packedPath)) return c.json({ error: '像素数据不见了' }, 404);
    try {
      const status = await deps.bridge.device(mac);
      if (!status.online) return c.json({ error: '设备不在线' }, 409);
      const version = status.features?.['xiaodan'];
      if (!(typeof version === 'number' && version >= 2)) return c.json({ error: '设备固件太旧,显示不了图片' }, 409);
      const palette = JSON.parse(row.palette_json) as Color[];
      const result = await deps.bridge.send(mac, imageMessages(row.id, { size: 128, palette, packed: readFileSync(packedPath) }));
      return result.status === 200 ? c.json({ ok: true }) : c.json({ error: `发送失败 HTTP ${result.status}` }, 502);
    } catch (error) {
      return c.json({ error: (error as Error).message }, 502);
    }
  });

  app.delete('/:id', (c) => {
    const row = one<ImageRow>(conn, 'SELECT * FROM images WHERE id = ?', Number(c.req.param('id')));
    if (row) {
      for (const suffix of [`.${row.ext}`, '.pixel.bin', '.pixel.png']) {
        const path = join(dir(), `${row.id}${suffix}`);
        if (existsSync(path)) unlinkSync(path);
      }
      run(conn, 'DELETE FROM images WHERE id = ?', row.id);
    }
    return c.json({ ok: true });
  });

  return app;
}

// 文生图:像素化、设备分片消息、各家服务商的请求形状、生成入库与工具、画廊接口。

import { strict as assert } from 'node:assert';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, describe, test } from 'node:test';
import { PNG } from 'pngjs';
import { one, openMemoryDb, run, type Db } from '../src/db.ts';
import { DEFAULT_AGENT_ID, seed } from '../src/seed.ts';
import { createApp } from '../src/app.ts';
import '../src/agent/index.ts';
import { Bridge } from '../src/agent/bridge.ts';
import { collectTools } from '../src/agent/registry.ts';
import { loadAgent } from '../src/agent/routes.ts';
import { decodeImage, imageMessages, pack4, pixelate, unpack4 } from '../src/agent/image/pixel.ts';
import { dashscopeImage, devicePrompt, openaiImages, qwenImage } from '../src/agent/image/providers.ts';
import { pixelateInWorker } from '../src/agent/image/run.ts';
import type { AgentDeps, ToolContext } from '../src/agent/types.ts';

function samplePng(width = 300, height = 200): Buffer {
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const o = (y * width + x) * 4;
      // 渐变底色加一个红色圆
      const inCircle = (x - width / 2) ** 2 + (y - height / 2) ** 2 < 50 ** 2;
      png.data[o] = inCircle ? 230 : Math.round((x / width) * 255);
      png.data[o + 1] = inCircle ? 40 : Math.round((y / height) * 255);
      png.data[o + 2] = inCircle ? 40 : 200;
      png.data[o + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

class SendBridge extends Bridge {
  sent: Record<string, unknown>[] = [];
  constructor() {
    super(() => 'http://engine:8003', () => 's', async () => new Response('{}'));
  }
  override async tools() {
    return null;
  }
  override async device() {
    return { online: true, session_id: 's', features: { xiaodan: 2 } };
  }
  override async send(_mac: string, messages: Record<string, unknown>[]) {
    this.sent.push(...messages);
    return { status: 200, data: {} };
  }
}

describe('像素化', () => {
  test('裁成正方形、16 色、4 位打包 8192 字节、预览放大 3 倍', () => {
    const art = pixelate(samplePng(), 128, 16);
    assert.equal(art.palette.length, 16);
    assert.equal(art.packed.length, 8192);
    assert.deepEqual([...unpack4(art.packed, 128 * 128)], [...art.indices]);
    const preview = decodeImage(art.preview);
    assert.deepEqual([preview.width, preview.height], [384, 384]);
    // 圆心像素应该接近红色
    const center = art.palette[art.indices[64 * 128 + 64]!]!;
    assert.ok(center[0] > 150 && center[1] < 120, `圆心颜色 ${center}`);
  });

  test('打包顺序:高 4 位是左边的像素', () => {
    assert.deepEqual([...pack4(Uint8Array.from([1, 2, 15, 0, 7]))], [0x12, 0xf0, 0x70]);
  });

  test('工作线程里像素化与本线程结果一致', async () => {
    const bytes = samplePng();
    const inline = pixelate(bytes);
    const threaded = await pixelateInWorker(bytes);
    assert.deepEqual(threaded.palette, inline.palette);
    assert.ok(threaded.packed.equals(inline.packed));
  });

  test('设备消息:首片带尺寸与调色板,每条不超过 4 KB', () => {
    const art = pixelate(samplePng());
    const messages = imageMessages(70000, art);
    assert.equal(messages.length, 4);
    assert.equal(messages[0]!['id'], 70000 & 0xffff);
    assert.equal(messages[0]!['w'], 128);
    assert.match(String(messages[0]!['pal']), /^[0-9a-f]{96}$/u);
    assert.equal(messages[1]!['pal'], undefined);
    assert.ok(messages.every((m) => Buffer.byteLength(JSON.stringify({ ...m, session_id: 'x'.repeat(36) })) < 4096));
    const joined = Buffer.concat(messages.map((m) => Buffer.from(String(m['d']), 'base64')));
    assert.ok(joined.equals(art.packed));
  });
});

describe('服务商', () => {
  const png = samplePng(64, 64);
  const fetchFor = (handler: (url: string, body: any) => Response) => {
    const calls: { url: string; body: any; auth: string | null }[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      const body = init.body ? JSON.parse(String(init.body)) : null;
      calls.push({ url, body, auth: new Headers(init.headers).get('authorization') });
      if (url.startsWith('https://img.example/')) return new Response(png);
      return handler(url, body);
    };
    return { fetchImpl, calls };
  };
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

  test('qwen-image:compatible-mode 的 images/generations,关提示词扩写', async () => {
    const { fetchImpl, calls } = fetchFor(() => json({ data: [{ url: 'https://img.example/a.png' }] }));
    const outcome = await qwenImage(fetchImpl, { api_key: 'sk', workspace_id: 'ws' }, '小猫');
    assert.ok(outcome.bytes.equals(png));
    assert.equal(calls[0]!.url, 'https://ws.cn-beijing.maas.aliyuncs.com/compatible-mode/v1/images/generations');
    assert.deepEqual(calls[0]!.body, { model: 'qwen-image-3.0', prompt: '小猫', size: '1024x1024', n: 1, prompt_extend: false, watermark: false });
  });

  test('百炼原生接口', async () => {
    const { fetchImpl, calls } = fetchFor(() => json({ output: { choices: [{ message: { content: [{ image: 'https://img.example/b.png' }] } }] } }));
    await dashscopeImage(fetchImpl, { api_key: 'sk' }, '小狗');
    assert.equal(calls[0]!.url, 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation');
    assert.equal(calls[0]!.body.model, 'z-image-turbo');
    assert.deepEqual(calls[0]!.body.input.messages[0].content, [{ text: '小狗' }]);
  });

  test('OpenAI 兼容接口支持 b64_json;内容审核不通过给出明确提示', async () => {
    const { fetchImpl } = fetchFor(() => json({ data: [{ b64_json: png.toString('base64') }] }));
    const outcome = await openaiImages(fetchImpl, { base_url: 'https://ark.example/api/v3', api_key: 'k', model: 'seedream' }, 'x');
    assert.ok(outcome.bytes.equals(png));
    const blocked = fetchFor(() => json({ code: 'DataInspectionFailed', message: 'Input data may contain inappropriate content.' }, 400));
    await assert.rejects(qwenImage(blocked.fetchImpl, { api_key: 'sk' }, 'x'), /内容安全审核/u);
  });

  test('给小屏幕的提示词与儿童约束', () => {
    assert.match(devicePrompt('小猫', false), /主体居中/u);
    assert.match(devicePrompt('小猫', true), /适合儿童/u);
  });
});

describe('画画工具与画廊', () => {
  let conn: Db;
  let dataDir: string;
  const MAC = '4c:11:ae:31:7a:30';

  beforeEach(() => {
    conn = openMemoryDb();
    seed(conn);
    dataDir = mkdtempSync(join(tmpdir(), 'xiaodan-images-'));
    run(conn, "UPDATE agents SET runtime = 'agent', safety_level = 'child' WHERE id = ?", DEFAULT_AGENT_ID);
    run(conn, 'DELETE FROM agent_plugins WHERE agent_id = ?', DEFAULT_AGENT_ID);
    run(conn, "INSERT INTO agent_plugins (agent_id, plugin_code, params_json) VALUES (?, 'image', '{}')", DEFAULT_AGENT_ID);
    run(conn, "INSERT INTO models (id, model_type, name, provider, config_json) VALUES ('TTS_Q', 'TTS', 'q', 'qwen_audio_tts', ?)",
      JSON.stringify({ api_key: 'sk-qwen', workspace_id: 'ws' }));
    run(conn, "INSERT INTO service_providers (id, kind, name, provider, config_json, is_default) VALUES ('img', 'image', 'q', 'qwen-image', ?, 1)",
      JSON.stringify({ key_from_model: 'TTS_Q' }));
    run(conn, 'INSERT INTO devices (mac, agent_id) VALUES (?, ?)', MAC, DEFAULT_AGENT_ID);
  });

  test('出图、像素化、入库、分片发到设备;沿用千问模型的密钥;儿童模式约束提示词', async () => {
    const png = samplePng();
    const prompts: string[] = [];
    const auths: string[] = [];
    const fetchImpl = async (url: string, init: RequestInit = {}) => {
      if (url.startsWith('https://img.example/')) return new Response(png);
      prompts.push(JSON.parse(String(init.body)).prompt);
      auths.push(new Headers(init.headers).get('authorization') ?? '');
      return new Response(JSON.stringify({ data: [{ url: 'https://img.example/c.png' }] }), { headers: { 'content-type': 'application/json' } });
    };
    const device: Record<string, unknown>[] = [];
    const deps: AgentDeps = { conn, fetch: fetchImpl, bridge: new SendBridge(), dataDir: () => dataDir };
    const ctx: ToolContext = {
      deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: { mac: MAC, sessionId: 's', turnId: null, clientIp: null, features: { xiaodan: 2 } },
      sink: { text() {}, device: (m) => device.push(m), media() {}, closeAfterTurn() {} }, signal: new AbortController().signal, conversationKey: 'k',
    };
    const tool = (await collectTools(ctx)).find((t) => t.name === 'generate_image')!;
    const result = await tool.run(ctx, { prompt: '戴帽子的小猫' });
    assert.equal(result.ok, true);
    assert.match(result.content, /显示在设备屏幕上/u);
    assert.equal(auths[0], 'Bearer sk-qwen');
    assert.match(prompts[0]!, /^戴帽子的小猫。.*适合儿童/u);
    assert.equal(device.filter((m) => m['type'] === 'xiaodan_img').length, 4);
    const row = one<{ id: number; prompt: string; mac: string }>(conn, 'SELECT id, prompt, mac FROM images')!;
    assert.deepEqual({ prompt: row.prompt, mac: row.mac }, { prompt: '戴帽子的小猫', mac: MAC });
    for (const suffix of ['.png', '.pixel.bin', '.pixel.png']) assert.ok(existsSync(join(dataDir, 'images', `${row.id}${suffix}`)), suffix);

    // 画廊:列表、原图、像素预览、重新发送、删除
    const bridge = new SendBridge();
    const app = createApp(conn, { agent: { fetch: fetchImpl, bridge, dataDir: () => dataDir, log: () => {} } });
    const list = await (await app.request('http://localhost/api/images')).json() as { items: { id: number }[] };
    assert.equal(list.items.length, 1);
    assert.equal((await app.request(`http://localhost/api/images/${row.id}/original`)).headers.get('content-type'), 'image/png');
    assert.equal((await app.request(`http://localhost/api/images/${row.id}/pixel`)).status, 200);
    const sent = await app.request(`http://localhost/api/images/${row.id}/send`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(sent.status, 200);
    assert.equal(bridge.sent.length, 4);
    await app.request(`http://localhost/api/images/${row.id}`, { method: 'DELETE' });
    assert.ok(!existsSync(join(dataDir, 'images', `${row.id}.png`)));
  });

  test('老固件不发图片,只提示去画廊;没配服务时如实失败', async () => {
    const device: Record<string, unknown>[] = [];
    const deps: AgentDeps = { conn, fetch: async () => new Response('{}'), bridge: new SendBridge(), dataDir: () => dataDir };
    const ctx: ToolContext = {
      deps, agent: loadAgent(deps, DEFAULT_AGENT_ID)!, device: { mac: MAC, sessionId: 's', turnId: null, clientIp: null, features: { xiaodan: true } },
      sink: { text() {}, device: (m) => device.push(m), media() {}, closeAfterTurn() {} }, signal: new AbortController().signal, conversationKey: 'k',
    };
    run(conn, 'DELETE FROM service_providers');
    const tool = (await collectTools(ctx)).find((t) => t.name === 'generate_image')!;
    const result = await tool.run(ctx, { prompt: '小猫' });
    assert.equal(result.ok, false);
    assert.match(result.content, /还没有配置画图服务/u);
    assert.equal(device.length, 0);
  });
});

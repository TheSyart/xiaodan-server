// 命令行工具。用于不方便点页面的场合:首次设置密码、从旧的单模块配置导入密钥。
//
//   node dist/cli.js set-password <用户名> <密码>
//   node dist/cli.js import-single-config <.config.yaml 路径>
//   node dist/cli.js show-secret
//   node dist/cli.js set <参数名> <值>

import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import { closeDb, one, openDb, run } from './db.ts';
import { seed, SECRET_KEY } from './seed.ts';
import { authMode, clearLocalAdmin, setAdmin } from './auth.ts';
import { getSetting, setSetting } from './settings.ts';
import { providerDef, type ModelType } from './catalog.ts';
import { defaultVoiceOf, loadTtsModel, syncSystemVoices } from './voice/store.ts';

/** 单模块 .config.yaml 里的模块段 → 我们的模型类型。 */
const SECTIONS: [string, ModelType][] = [
  ['ASR', 'ASR'],
  ['LLM', 'LLM'],
  ['TTS', 'TTS'],
  ['VAD', 'VAD'],
];

/**
 * 从小智单模块的 .config.yaml 导入模型配置(含密钥)。
 *
 * 这样密钥就不必经由人手复制粘贴,也不会出现在命令历史或聊天记录里。
 * 只导入 selected_module 选中的那几个 —— 配置文件里通常还堆着十几个
 * 从没用过的示例条目,全导进来只会让模型页一片噪声。
 */
function importSingleConfig(path: string): void {
  const conn = openDb();
  seed(conn);

  const raw = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  const selected = (raw['selected_module'] ?? {}) as Record<string, string>;
  if (Object.keys(selected).length === 0) {
    console.error('这个文件里没有 selected_module,不像是单模块配置');
    process.exitCode = 1;
    return;
  }

  let imported = 0;
  const chosen: Record<string, string> = {};

  for (const [section, type] of SECTIONS) {
    const name = selected[section];
    if (!name) continue;
    const bucket = raw[section] as Record<string, Record<string, unknown>> | undefined;
    const config = bucket?.[name];
    if (!config) {
      console.warn(`跳过 ${section}:selected_module 指向 ${name},但文件里没有这一段`);
      continue;
    }
    const provider = String(config['type'] ?? '');
    if (!provider) {
      console.warn(`跳过 ${section}.${name}:缺少 type 字段`);
      continue;
    }
    if (!providerDef(type, provider)) {
      console.warn(`跳过 ${section}.${name}:目录里没有登记 ${provider} 这个供应商,`
        + '如果确实要用,请先在 catalog.ts 里补上它的字段定义');
      continue;
    }

    const id = `${type}_${name}`;
    run(
      conn,
      `INSERT INTO models (id, model_type, name, provider, config_json, is_default, enabled, remark)
       VALUES (?, ?, ?, ?, ?, 1, 1, ?)
       ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, config_json = excluded.config_json,
                                      is_default = 1, enabled = 1, updated_at = datetime('now')`,
      id, type, name, provider, JSON.stringify(config), `由 ${path} 导入`,
    );
    // 同类型的其他项取消默认
    run(conn, 'UPDATE models SET is_default = 0 WHERE model_type = ? AND id <> ?', type, id);
    chosen[type] = id;
    imported += 1;
    const hasKey = typeof config['api_key'] === 'string' && String(config['api_key']).length > 0;
    console.log(`导入 ${type}: ${id} (${provider}${hasKey ? ',含密钥' : ''})`);
  }

  // 把导入的模型挂到默认智能体上,省得再去页面点一遍
  const agent = one<{ id: string }>(conn, 'SELECT id FROM agents WHERE is_default = 1 LIMIT 1');
  if (agent) {
    const columns: Record<string, string> = { VAD: 'vad_model_id', ASR: 'asr_model_id', LLM: 'llm_model_id' };
    for (const [type, id] of Object.entries(chosen)) {
      const column = columns[type];
      if (column) run(conn, `UPDATE agents SET ${column} = ? WHERE id = ?`, id, agent.id);
    }
    // 合成模型挂在音色上:导入的千问合成模型补齐系统音色,默认智能体用它的默认音色
    const tts = chosen['TTS'] ? loadTtsModel(conn, chosen['TTS']) : undefined;
    if (tts) {
      syncSystemVoices(conn, tts.id);
      const voice = defaultVoiceOf(conn, tts);
      if (voice) run(conn, 'UPDATE agents SET tts_voice_id = ? WHERE id = ?', voice.id, agent.id);
    }
    console.log(`已挂到默认智能体 ${agent.id}`);
  }

  // 人设与接入地址也一并搬过来
  const prompt = raw['prompt'];
  if (typeof prompt === 'string' && prompt.trim() && agent) {
    run(conn, 'UPDATE agents SET system_prompt = ? WHERE id = ?', prompt.trim(), agent.id);
    console.log('已导入人设');
  }
  const server = raw['server'] as Record<string, unknown> | undefined;
  const ws = server?.['websocket'];
  if (typeof ws === 'string' && ws && !ws.includes('你的')) {
    setSetting(conn, 'server.websocket', ws);
    console.log(`已导入设备连接地址 ${ws}`);
  }

  console.log(`\n完成,共导入 ${imported} 个模型。`);
  console.log('注意:密钥已写入数据库,请不要把数据目录提交到版本库。');
  closeDb();
}

function main(): void {
  const [command, ...args] = process.argv.slice(2);

  switch (command) {
    case 'set-password': {
      const [username, password] = args;
      if (!username || !password) {
        console.error('用法: set-password <用户名> <密码>');
        process.exitCode = 1;
        return;
      }
      if (password.length < 8) {
        console.error('密码至少 8 位');
        process.exitCode = 1;
        return;
      }
      const conn = openDb();
      seed(conn);
      setAdmin(conn, username, password);
      closeDb();
      console.log(`已设置管理员 ${username},所有现存会话已注销。`);
      return;
    }

    case 'import-single-config': {
      const [path] = args;
      if (!path) {
        console.error('用法: import-single-config <.config.yaml 路径>');
        process.exitCode = 1;
        return;
      }
      importSingleConfig(path);
      return;
    }

    case 'clear-local-admin': {
      // 切到面板统一鉴权后,把控制台自己的账号与会话擦掉,不留第二套凭据。
      const conn = openDb();
      seed(conn);
      clearLocalAdmin(conn);
      closeDb();
      console.log('本地管理员与全部会话已清除。当前鉴权模式:' + authMode());
      return;
    }

    case 'show-secret': {
      const conn = openDb();
      seed(conn);
      console.log(getSetting(conn, SECRET_KEY) ?? '');
      closeDb();
      return;
    }

    case 'set': {
      const [key, value] = args;
      if (!key || value === undefined) {
        console.error('用法: set <参数名> <值>');
        process.exitCode = 1;
        return;
      }
      const conn = openDb();
      seed(conn);
      if (!one(conn, 'SELECT 1 FROM settings WHERE key = ?', key)) {
        console.error(`没有名为 ${key} 的参数`);
        process.exitCode = 1;
        closeDb();
        return;
      }
      setSetting(conn, key, value);
      closeDb();
      console.log(`${key} = ${value}`);
      return;
    }

    default:
      console.log('可用命令:');
      console.log('  set-password <用户名> <密码>          设置管理员(仅 local 模式需要)');
      console.log('  clear-local-admin                      清除本地账号与会话(切到面板鉴权后用)');
      console.log('  import-single-config <配置路径>        从单模块 .config.yaml 导入模型与密钥');
      console.log('  show-secret                            打印服务端接入密钥');
      console.log('  set <参数名> <值>                      修改一个系统参数');
      process.exitCode = command ? 1 : 0;
  }
}

main();

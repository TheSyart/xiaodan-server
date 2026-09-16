// 系统参数:键名、类型与默认值。
//
// 这些键会被 server-base 接口按点号拆成嵌套对象下发,所以**键名必须与小智服务端
// 读取的完全一致**。下面每一项都在容器里核对过确有代码读取(把服务端所有
// `config["x"]` / `config.get("x")` 扫了一遍,与默认 config.yaml 的顶层键取交集)。
//
// 上游还有一批参数我们不要:短信、SM2 公私钥、多用户注册开关、备案号、
// MQTT 网关、智控台菜单开关。它们服务于官方那套多租户 + 手机注册的产品形态。

import type { Db } from './db.ts';
import { all, run } from './db.ts';

export type ValueType = 'string' | 'number' | 'boolean' | 'array' | 'json';

export interface SettingDef {
  key: string;
  value: string;
  type: ValueType;
  label: string;
  /** true = 只有服务端读,控制台设置页不展示 */
  internal?: boolean;
}

export const DEFAULT_SETTINGS: SettingDef[] = [
  // ---- 设备接入 ----
  {
    key: 'server.websocket',
    value: '',
    type: 'string',
    label: '设备连接地址(WebSocket)',
  },
  {
    key: 'server.ota',
    value: '',
    type: 'string',
    label: 'OTA 接口地址',
  },
  {
    key: 'server.auth.enabled',
    value: 'false',
    type: 'boolean',
    label: '设备连接需要令牌',
  },

  // ---- 智能体大脑(控制塔运行时)----
  // 两个地址都是容器内网地址:运维面板编排里组件名是 console 与 engine;用本仓库 compose.yaml 手工部署时是
  // xiaodan-console 与 xiaodan-engine,要在设置页改。
  {
    key: 'agent.turn_url',
    value: 'http://console:8002/xiaodan/agent/turn',
    type: 'string',
    label: '引擎访问控制塔对话接口的地址(内网)',
  },
  {
    key: 'agent.bridge_url',
    value: 'http://engine:8003',
    type: 'string',
    label: '控制塔访问引擎设备桥的地址(内网)',
  },

  // ---- 对话行为 ----
  {
    key: 'device_max_output_size',
    value: '0',
    type: 'number',
    label: '单设备每日最大输出字数(0 为不限)',
  },
  {
    key: 'close_connection_no_voice_time',
    value: '600',
    type: 'number',
    label: '无语音多久后断开连接(秒)',
  },
  { key: 'tts_timeout', value: '15', type: 'number', label: '语音合成超时(秒)' },
  { key: 'tool_call_timeout', value: '30', type: 'number', label: '工具调用超时(秒)' },
  // 引擎只在唤醒词路径读它(listenMessageHandler),按键说话的设备上开关没有任何效果,所以不在设置页展示。
  { key: 'enable_greeting', value: 'true', type: 'boolean', label: '唤醒后主动打招呼', internal: true },
  {
    key: 'delete_audio',
    value: 'true',
    type: 'boolean',
    label: '用完即删服务端音频文件',
  },
  {
    key: 'exit_commands',
    value: '',
    type: 'array',
    label: '退出指令(分号分隔)',
  },
  {
    key: 'system_error_response',
    value: '主人,小单现在有点忙,我们稍后再试吧。',
    type: 'string',
    label: '系统故障时的回复',
  },
  { key: 'end_prompt.enable', value: 'true', type: 'boolean', label: '启用告别语' },
  {
    key: 'end_prompt.prompt',
    value: '请你以"时间过得真快"开头,用富有感情、依依不舍的话来结束这场对话吧!',
    type: 'string',
    label: '告别语提示词',
  },

  // ---- 唤醒与提示音(本硬件按键说话,唤醒词用不上,保留以防换形态)----
  {
    key: 'wakeup_words',
    value: '你好小单;小单小单;你好小智',
    type: 'array',
    label: '唤醒词(分号分隔)',
    internal: true,
  },
  {
    key: 'enable_wakeup_words_response_cache',
    value: 'true',
    type: 'boolean',
    label: '缓存唤醒回应',
    internal: true,
  },
  {
    key: 'enable_stop_tts_notify',
    value: 'false',
    type: 'boolean',
    label: '打断时播放提示音',
    internal: true,
  },
  {
    key: 'stop_tts_notify_voice',
    value: 'config/assets/tts_notify.mp3',
    type: 'string',
    label: '打断提示音文件',
    internal: true,
  },
  {
    key: 'enable_websocket_ping',
    value: 'false',
    type: 'boolean',
    label: '启用 WebSocket 心跳',
    internal: true,
  },
  {
    key: 'tts_audio_send_delay',
    value: '0',
    type: 'number',
    label: '音频发送延迟(毫秒)',
    internal: true,
  },

  // ---- 日志 ----
  { key: 'log.log_level', value: 'INFO', type: 'string', label: '服务端日志级别' },
  { key: 'log.log_dir', value: 'tmp', type: 'string', label: '日志目录', internal: true },
  { key: 'log.log_file', value: 'server.log', type: 'string', label: '日志文件', internal: true },
  { key: 'log.data_dir', value: 'data', type: 'string', label: '数据目录', internal: true },
  {
    key: 'log.log_format',
    value:
      '<green>{time:YYMMDD HH:mm:ss}</green>[<light-blue>{version}-{selected_module}</light-blue>]' +
      '[<light-blue>{extra[tag]}</light-blue>]-<level>{level}</level>-<light-green>{message}</light-green>',
    type: 'string',
    label: '控制台日志格式',
    internal: true,
  },
  {
    key: 'log.log_format_file',
    value: '{time:YYYY-MM-DD HH:mm:ss} - {version}_{selected_module} - {name} - {level} - {extra[tag]} - {message}',
    type: 'string',
    label: '文件日志格式',
    internal: true,
  },

  // ---- 设备握手模板 ----
  // 服务端把它原样当作 hello 回包。采样率只是默认值:真实值由设备在自己的
  // hello 里声明,服务端会据此动态更新(connection.py 里 sample_rate 会被覆盖),
  // 所以这里保持上游默认的 24000 不会影响 16kHz 的设备。
  {
    key: 'xiaozhi',
    value: JSON.stringify({
      type: 'hello',
      version: 1,
      transport: 'websocket',
      audio_params: { format: 'opus', sample_rate: 24000, channels: 1, frame_duration: 60 },
    }),
    type: 'json',
    label: '设备握手回包模板',
    internal: true,
  },
];

/** 把字符串值按声明类型还原成 JSON 值。转换规则与上游 buildConfig 一致。 */
export function castValue(value: string, type: ValueType): unknown {
  switch (type) {
    case 'number': {
      const n = Number(value);
      if (!Number.isFinite(n)) return value;
      return Number.isInteger(n) ? n : n;
    }
    case 'boolean':
      return value === 'true';
    case 'array':
      return value
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item.length > 0);
    case 'json':
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    case 'string':
    default:
      return value;
  }
}

/**
 * 把扁平的参数表展开成嵌套对象。`server.auth.enabled` → `{server:{auth:{enabled:…}}}`。
 * 这是 server-base 响应的主体,上游 ConfigServiceImpl.buildConfig 做的是同一件事。
 */
export function nestSettings(rows: { key: string; value: string; value_type: ValueType }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const row of rows) {
    const parts = row.key.split('.');
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const part = parts[i]!;
      const existing = cursor[part];
      if (typeof existing !== 'object' || existing === null || Array.isArray(existing)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]!] = castValue(row.value, row.value_type);
  }
  return out;
}

export function readAllSettings(conn: Db): { key: string; value: string; value_type: ValueType }[] {
  return all(conn, 'SELECT key, value, value_type FROM settings ORDER BY key');
}

export function getSetting(conn: Db, key: string): string | undefined {
  const row = all<{ value: string }>(conn, 'SELECT value FROM settings WHERE key = ?', key)[0];
  return row?.value;
}

export function setSetting(conn: Db, key: string, value: string): void {
  run(conn, "UPDATE settings SET value = ?, updated_at = datetime('now') WHERE key = ?", value, key);
}

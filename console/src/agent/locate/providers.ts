// 定位服务商:高德「智能硬件定位」(设备扫到的 Wi-Fi 热点 → 坐标),以及按公网 IP 的城市级兜底。
//
// 高德那个接口本来就是给这种硬件用的:传已连接的热点(mmac)与扫到的热点列表(macs),
// 返回经纬度与一个精度半径。**至少要两个热点**才定得出来,只有一个时基本只能退回 IP。
// 坐标是高德坐标系(GCJ-02),页面上照实标注,不做转换。
//
// IP 兜底用太平洋网络的 whois 库(无密钥、GBK 编码),与引擎里天气插件查城市用的是同一家,
// 粒度是地级市,没有坐标。

import type { FetchLike } from '../../voice/dashscope.ts';

export interface Bss {
  /** 12 位十六进制,没有分隔符 */
  bssid: string;
  rssi: number;
}

export interface LocateResult {
  source: 'wifi' | 'ip';
  lng: number | null;
  lat: number | null;
  radius: number;
  province: string;
  city: string;
  district: string;
  address: string;
  provider: string;
}

export class LocateError extends Error {}

const AMAP_URL = 'https://apilocate.amap.com/position';
/** 中国大陆的经纬度范围不相交,据此认出高德给的是「经度,纬度」还是反过来 */
const inLng = (value: number) => value >= 73 && value <= 136;
const inLat = (value: number) => value >= 3 && value <= 54;

/** "aabbccddeeff" → "aa:bb:cc:dd:ee:ff";不合法返回空串 */
export function colonMac(bssid: string): string {
  const clean = bssid.replace(/[^0-9a-fA-F]/gu, '').toLowerCase();
  return clean.length === 12 ? (clean.match(/.{2}/gu) ?? []).join(':') : '';
}

/**
 * 高德返回的 location 是 "经度,纬度" 还是 "纬度,经度",文档与其他接口对不上,不要赌:
 * 按中国的范围自己判,判不出来就当没有坐标。
 */
export function parseLocation(value: unknown): { lng: number; lat: number } | null {
  const parts = String(value ?? '').split(',').map((part) => Number(part.trim()));
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
  const [a, b] = parts as [number, number];
  if (inLng(a) && inLat(b)) return { lng: a, lat: b };
  if (inLng(b) && inLat(a)) return { lng: b, lat: a };
  return null;
}

export interface AmapConfig {
  api_key?: unknown;
  endpoint?: unknown;
  /** 高德要不要 SSID:固件不上报 SSID,留空;真机联调发现不接受空值时填一个占位串 */
  ssid_placeholder?: unknown;
}

/** 扫到的热点 → 坐标。aps 少于两个时高德基本定不出来,调用方应改走 IP 兜底。 */
export async function locateByWifi(
  fetchImpl: FetchLike, config: AmapConfig, input: { self?: Bss | null; aps: readonly Bss[] }, timeoutMs = 8000,
): Promise<LocateResult> {
  const key = String(config.api_key ?? '').trim();
  if (!key) throw new LocateError('定位服务还没有填 Key');
  const ssid = String(config.ssid_placeholder ?? '');
  const one = (bss: Bss) => `${colonMac(bss.bssid)},${Math.round(bss.rssi)},${ssid}`;
  const aps = input.aps.filter((bss) => colonMac(bss.bssid)).slice(0, 30);
  if (aps.length < 2) throw new LocateError('扫到的热点不够(至少要两个)');
  const url = new URL(String(config.endpoint ?? '') || AMAP_URL);
  url.searchParams.set('key', key);
  url.searchParams.set('accesstype', '1');
  url.searchParams.set('output', 'JSON');
  url.searchParams.set('macs', aps.map(one).join('|'));
  if (input.self && colonMac(input.self.bssid)) url.searchParams.set('mmac', one(input.self));

  let response: Response;
  try {
    response = await fetchImpl(url.toString(), { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new LocateError(`连不上高德定位:${(error as Error).message}`);
  }
  const text = await response.text();
  if (!response.ok) throw new LocateError(`高德定位返回 HTTP ${response.status}:${text.slice(0, 120)}`);
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new LocateError(`高德定位返回的不是 JSON:${text.slice(0, 120)}`);
  }
  const info = String(data['info'] ?? '');
  if (String(data['status'] ?? '') !== '1') {
    throw new LocateError(`高德定位没有结果:${info || '未知原因'}`);
  }
  const result = (data['result'] ?? {}) as Record<string, unknown>;
  const point = parseLocation(result['location']);
  if (!point) throw new LocateError('高德定位没有返回可用的坐标');
  const radius = Number(result['radius']);
  return {
    source: 'wifi',
    lng: point.lng,
    lat: point.lat,
    radius: Number.isFinite(radius) ? Math.round(radius) : 0,
    province: String(result['province'] ?? ''),
    city: String(result['city'] ?? ''),
    district: String(result['district'] ?? ''),
    address: String(result['desc'] ?? result['address'] ?? ''),
    provider: 'amap',
  };
}

/** 内网、回环、CGNAT 这些查不出位置 */
export function isPublicIp(ip: string): boolean {
  const value = ip.trim();
  if (!value || value === '::1' || value.startsWith('127.') || value.startsWith('169.254.')) return false;
  if (value.startsWith('10.') || value.startsWith('192.168.')) return false;
  const parts = value.split('.').map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return false;
    if (parts[0] === 100 && parts[1]! >= 64 && parts[1]! <= 127) return false;   // CGNAT
    return true;
  }
  return !value.startsWith('fe80:') && !value.startsWith('fc') && !value.startsWith('fd');
}

/** 日志里的 IP 一律打码 */
export function maskIp(ip: string): string {
  if (ip.includes(':')) return `${ip.split(':').slice(0, 2).join(':')}:…`;
  const parts = ip.split('.');
  return parts.length === 4 ? `${parts.slice(0, 3).join('.')}.*` : '…';
}

/** 按公网 IP 查到地级市。没有坐标,精度就是「这座城市」。 */
export async function locateByIp(fetchImpl: FetchLike, ip: string, timeoutMs = 5000): Promise<LocateResult> {
  if (!isPublicIp(ip)) throw new LocateError('不是公网 IP(检查 nginx 有没有转发 X-Real-IP)');
  const url = `https://whois.pconline.com.cn/ipJson.jsp?${new URLSearchParams({ json: 'true', ip }).toString()}`;
  let response: Response;
  try {
    response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new LocateError(`连不上 IP 定位服务:${(error as Error).message}`);
  }
  if (!response.ok) throw new LocateError(`IP 定位返回 HTTP ${response.status}`);
  // 这家返回的是 GBK
  const body = new TextDecoder('gbk').decode(await response.arrayBuffer());
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(body.slice(body.indexOf('{'), body.lastIndexOf('}') + 1)) as Record<string, unknown>;
  } catch {
    throw new LocateError('IP 定位返回的内容看不懂');
  }
  const strip = (value: unknown) => String(value ?? '').replace(/(省|市|自治区|特别行政区)$/u, '');
  const city = strip(data['city']) || strip(data['pro']);
  if (!city) throw new LocateError('这个 IP 查不到城市');
  return {
    source: 'ip',
    lng: null,
    lat: null,
    radius: 0,
    province: strip(data['pro']),
    city,
    district: '',
    address: String(data['addr'] ?? '').trim(),
    provider: 'pconline',
  };
}

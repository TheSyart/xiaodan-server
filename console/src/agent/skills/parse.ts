// 解析技能包。格式兼容 Agent Skills:一个 SKILL.md(YAML frontmatter 里的 name、description,可选 allowed-tools)
// 加若干附带文件。控制塔不执行脚本,只收文本文件;整包 256 KB 以内。
// 支持三种导入:直接粘贴 SKILL.md 文字、上传 SKILL.md、上传 .zip(自己读 zip 目录并用 node:zlib 解压,不引依赖)。

import { inflateRawSync } from 'node:zlib';

export interface SkillPackage {
  name: string;
  description: string;
  body: string;
  allowedTools: string[];
  files: Record<string, string>;
  skipped: string[];
}

export class SkillError extends Error {}

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const TEXT_EXT = /\.(md|txt|json|csv|ya?ml|tsv)$/iu;
const MAX_TOTAL = 256 * 1024;
const MAX_FILES = 50;

function unquote(value: string): string {
  const v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}

/** 只认 frontmatter 里用得到的简单写法:key: value、key: [a, b]、以及 "- item" 列表 */
export function parseSkillMarkdown(markdown: string): { name: string; description: string; body: string; allowedTools: string[] } {
  const text = markdown.replace(/^﻿/u, '').replace(/\r\n/gu, '\n');
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text);
  if (!match) throw new SkillError('SKILL.md 开头要有 --- 包起来的 frontmatter(至少写 name 与 description)');
  const meta: Record<string, string | string[]> = {};
  let listKey: string | null = null;
  for (const raw of match[1]!.split('\n')) {
    const line = raw.replace(/\s+#.*$/u, '');
    if (!line.trim()) continue;
    const item = /^\s+-\s+(.*)$/u.exec(line);
    if (item && listKey) {
      (meta[listKey] as string[]).push(unquote(item[1]!));
      continue;
    }
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/u.exec(line);
    if (!kv) continue;
    const key = kv[1]!.toLowerCase();
    const value = kv[2]!.trim();
    if (value === '') {
      meta[key] = [];
      listKey = key;
    } else if (value.startsWith('[') && value.endsWith(']')) {
      meta[key] = value.slice(1, -1).split(',').map(unquote).filter(Boolean);
      listKey = null;
    } else {
      meta[key] = unquote(value);
      listKey = null;
    }
  }
  const name = typeof meta['name'] === 'string' ? meta['name'].trim() : '';
  const description = typeof meta['description'] === 'string' ? meta['description'].trim() : '';
  if (!NAME.test(name) || name.length > 64) throw new SkillError('技能 name 只能用小写字母、数字与连字符,最长 64 个字符');
  if (!description || description.length > 1024) throw new SkillError('技能要有 description,最长 1024 个字符');
  const tools = meta['allowed-tools'];
  const allowedTools = (Array.isArray(tools) ? tools : typeof tools === 'string' ? tools.split(/[,\s]+/u) : [])
    .map((t) => t.trim()).filter(Boolean);
  const body = match[2]!.trim();
  if (!body) throw new SkillError('SKILL.md 的正文是空的');
  return { name, description, body, allowedTools };
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  size: number;
  offset: number;
}

/** 读 zip 的中央目录(不支持 zip64 与加密) */
export function readZip(buffer: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let eocd = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new SkillError('不是有效的 zip 文件');
  const count = buffer.readUInt16LE(eocd + 10);
  let pointer = buffer.readUInt32LE(eocd + 16);
  const entries: ZipEntry[] = [];
  for (let i = 0; i < count; i += 1) {
    if (buffer.readUInt32LE(pointer) !== 0x02014b50) throw new SkillError('zip 目录损坏');
    const method = buffer.readUInt16LE(pointer + 10);
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const size = buffer.readUInt32LE(pointer + 24);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const extraLength = buffer.readUInt16LE(pointer + 30);
    const commentLength = buffer.readUInt16LE(pointer + 32);
    const offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.subarray(pointer + 46, pointer + 46 + nameLength).toString('utf8');
    entries.push({ name, method, compressedSize, size, offset });
    pointer += 46 + nameLength + extraLength + commentLength;
  }
  let total = 0;
  for (const entry of entries) {
    if (entry.name.endsWith('/')) continue;
    total += entry.size;
    if (total > MAX_TOTAL * 4) throw new SkillError('技能包解压后太大');
    const local = entry.offset;
    if (buffer.readUInt32LE(local) !== 0x04034b50) throw new SkillError('zip 文件头损坏');
    const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
    const data = buffer.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) out.set(entry.name, Buffer.from(data));
    else if (entry.method === 8) out.set(entry.name, inflateRawSync(data, { maxOutputLength: MAX_TOTAL * 4 }));
    else throw new SkillError(`不支持的 zip 压缩方式 ${entry.method}`);
  }
  return out;
}

function safePath(path: string): string | null {
  const normalized = path.replace(/\\/gu, '/').replace(/^\.\//u, '');
  if (!normalized || normalized.startsWith('/') || normalized.split('/').some((part) => part === '..' || part === '')) return null;
  return normalized;
}

/** 由 zip 内容组装技能包:SKILL.md 可以在根目录,也可以在唯一的一层子目录里 */
export function packageFromZip(buffer: Buffer): SkillPackage {
  const entries = readZip(buffer);
  const skillPath = [...entries.keys()].filter((name) => /(^|\/)SKILL\.md$/u.test(name)).sort((a, b) => a.length - b.length)[0];
  if (!skillPath) throw new SkillError('zip 里没有 SKILL.md');
  const root = skillPath.slice(0, skillPath.length - 'SKILL.md'.length);
  const parsed = parseSkillMarkdown(entries.get(skillPath)!.toString('utf8'));
  const files: Record<string, string> = {};
  const skipped: string[] = [];
  let total = Buffer.byteLength(parsed.body);
  for (const [name, data] of entries) {
    if (name === skillPath || !name.startsWith(root)) continue;
    const relative = safePath(name.slice(root.length));
    if (!relative || relative.startsWith('__MACOSX/') || relative.split('/').some((p) => p.startsWith('.'))) continue;
    if (!TEXT_EXT.test(relative)) {
      skipped.push(relative);
      continue;
    }
    total += data.length;
    if (total > MAX_TOTAL) throw new SkillError('技能包里的文本文件合计超过 256 KB');
    if (Object.keys(files).length >= MAX_FILES) throw new SkillError('技能包里的文件太多(最多 50 个)');
    files[relative] = data.toString('utf8');
  }
  return { ...parsed, files, skipped };
}

export function packageFromMarkdown(markdown: string): SkillPackage {
  if (Buffer.byteLength(markdown) > MAX_TOTAL) throw new SkillError('SKILL.md 超过 256 KB');
  return { ...parseSkillMarkdown(markdown), files: {}, skipped: [] };
}

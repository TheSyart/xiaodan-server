// 技能在智能体运行时里的样子:渐进披露。
//   - 系统提示词只列出本智能体启用的技能名字与描述;
//   - 模型需要时调用 load_skill 读出正文(本段对话之后的轮次自动带上正文,不用再读);
//   - 技能附带的文件用 read_skill_file 按需读。

import type { Db } from '../../db.ts';
import { all, one } from '../../db.ts';
import { conversations } from '../context.ts';
import { EXTRA_TOOL_SOURCES, PROMPT_EXTRAS } from '../registry.ts';
import type { AgentTool } from '../types.ts';

const FILE_CHARS = 16_000;

interface SkillRow {
  name: string;
  description: string;
  body: string;
  files_json: string;
}

export function agentSkills(conn: Db, agentId: string): SkillRow[] {
  return all<SkillRow>(conn,
    `SELECT s.name, s.description, s.body, s.files_json FROM agent_skills a JOIN skills s ON s.name = a.skill_name
     WHERE a.agent_id = ? AND s.enabled = 1 ORDER BY s.name`, agentId);
}

function files(row: SkillRow): Record<string, string> {
  try {
    return JSON.parse(row.files_json) as Record<string, string>;
  } catch {
    return {};
  }
}

const previous = PROMPT_EXTRAS.skills;
PROMPT_EXTRAS.skills = (ctx) => {
  const base = previous(ctx);
  const rows = agentSkills(ctx.deps.conn, ctx.agent.id);
  return {
    ...base,
    available: rows.map((row) => ({ name: row.name, description: row.description })),
    loaded: (conversation) => rows.filter((row) => conversation.loadedSkills.has(row.name)).map((row) => ({ name: row.name, body: row.body })),
  };
};

EXTRA_TOOL_SOURCES.push((ctx) => {
  const rows = agentSkills(ctx.deps.conn, ctx.agent.id);
  if (rows.length === 0) return [];
  const names = rows.map((row) => row.name);
  const loadSkill: AgentTool = {
    name: 'load_skill',
    label: '读取技能',
    description: `读取一个技能的完整做法说明。可用的技能:${names.join('、')}。`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', enum: names, description: '技能名' } },
      required: ['name'],
    },
    hint: '正在想办法',
    async run(toolCtx, args) {
      const row = one<SkillRow>(toolCtx.deps.conn, 'SELECT name, description, body, files_json FROM skills WHERE name = ? AND enabled = 1', String(args['name'] ?? ''));
      if (!row || !names.includes(row.name)) return { ok: false, content: `没有名为 ${String(args['name'])} 的技能。` };
      conversations.get(toolCtx.conversationKey, toolCtx.agent.id).loadedSkills.add(row.name);
      const attached = Object.keys(files(row));
      return {
        ok: true,
        content: `技能「${row.name}」的说明如下,照着做:\n\n${row.body}${attached.length ? `\n\n这个技能附带的文件(需要时用 read_skill_file 读):${attached.join('、')}` : ''}`,
      };
    },
  };
  const tools: AgentTool[] = [loadSkill];
  if (rows.some((row) => Object.keys(files(row)).length)) {
    tools.push({
      name: 'read_skill_file',
      label: '读取技能文件',
      description: '读取某个技能附带的文件内容。',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', enum: names, description: '技能名' },
          path: { type: 'string', description: '文件路径,例如 references/words.md' },
        },
        required: ['name', 'path'],
      },
      async run(toolCtx, args) {
        const row = rows.find((r) => r.name === args['name']);
        const content = row ? files(row)[String(args['path'] ?? '')] : undefined;
        if (content === undefined) return { ok: false, content: '没有这个文件。' };
        return { ok: true, content: content.length > FILE_CHARS ? `${content.slice(0, FILE_CHARS)}…(已截断)` : content };
      },
    });
  }
  return tools;
});

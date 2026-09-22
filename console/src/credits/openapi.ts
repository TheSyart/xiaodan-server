// 学分接口 v1 的 OpenAPI 3.1 描述,给 App 开发用(GET /open/v1/credits/openapi.json,不需要密钥)。
//
// 请求体的结构与取值范围直接由 schemas.ts 里路由校验用的 zod 定义生成(z.toJSONSchema),
// 接口改了这里自动跟着变。每条路径的说明写在下面的表里;test/credits.test.ts 会核对这张表
// 与路由实际注册的端点一一对应,漏写、多写都会失败。

import { z } from 'zod';
import {
  adjustBody, examplesBody, redeemBody, reorderBody, rewardCreate, rewardUpdate, ruleCreate, rulePreview, ruleUpdate,
  taskAssign, taskClaim, taskCustom, taskMissed, taskResult, taskUpdate, TASK_STATUSES, LEDGER_KINDS,
} from './schemas.ts';

type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';

interface Endpoint {
  method: Method;
  path: string;
  summary: string;
  tag: string;
  body?: z.ZodType;
  query?: { name: string; description: string; required?: boolean; enum?: readonly string[] }[];
}

const MAC_Q = { name: 'mac', description: '孩子(设备)的 MAC,紧凑写法如 4c11ae317a30', required: true };
const CURSOR = [
  { name: 'before', description: '翻页游标:上一页返回的 next' },
  { name: 'limit', description: '每页条数,默认 30,最大 100' },
];

/** 全部端点。PATCH 与 PUT 等价(部分更新),表里只列 PATCH,生成时自动补 PUT */
export const ENDPOINTS: Endpoint[] = [
  { method: 'get', path: '/meta', tag: '杂项', summary: '质量档位、状态与流水类型、各字段取值范围、服务器「今天」(北京时间)' },
  { method: 'get', path: '/overview', tag: '孩子', summary: '页面用的概览:设备列表、当前设备的余额与今天完成情况', query: [{ ...MAC_Q, required: false }] },
  { method: 'get', path: '/children', tag: '孩子', summary: '所有孩子(设备)及各自余额、今天完成情况、待确认的申报数' },
  { method: 'get', path: '/children/:mac', tag: '孩子', summary: '一个孩子的详情' },
  { method: 'post', path: '/examples', tag: '杂项', summary: '空设备一键建示例规则与奖励(已有的不重复建)', body: examplesBody },

  { method: 'get', path: '/rules', tag: '规则', summary: '作业规则列表', query: [MAC_Q, { name: 'archived', description: '1 = 连已停用的一起列' }] },
  { method: 'post', path: '/rules', tag: '规则', summary: '新建规则(没填的数值用默认)', body: ruleCreate },
  { method: 'post', path: '/rules/preview', tag: '规则', summary: '按给定数值试算得分,不保存', body: rulePreview },
  { method: 'post', path: '/rules/reorder', tag: '规则', summary: '按给定顺序重排', body: reorderBody },
  { method: 'get', path: '/rules/:id', tag: '规则', summary: '读取一条规则' },
  { method: 'patch', path: '/rules/:id', tag: '规则', summary: '改规则(只影响以后布置的作业)', body: ruleUpdate },
  { method: 'delete', path: '/rules/:id', tag: '规则', summary: '删除;布置过的规则改为停用,返回 result=archived' },
  { method: 'post', path: '/rules/:id/restore', tag: '规则', summary: '恢复已停用的规则' },

  {
    method: 'get', path: '/tasks', tag: '作业',
    summary: '只带 day(或都不带=今天):某天的清单 {day, items, summary};带 from/to/status/before:历史查询,按日期倒序 {items, next}',
    query: [MAC_Q, { name: 'day', description: 'YYYY-MM-DD' }, { name: 'from', description: 'YYYY-MM-DD' },
      { name: 'to', description: 'YYYY-MM-DD' }, { name: 'status', description: 'claimed = 孩子已报完成、等家长检查', enum: TASK_STATUSES }, ...CURSOR],
  },
  { method: 'post', path: '/tasks', tag: '作业', summary: '按规则布置(可一次多项;规则数值抄进作业快照)', body: taskAssign },
  { method: 'post', path: '/tasks/custom', tag: '作业', summary: '布置一项不挂规则的临时作业', body: taskCustom },
  { method: 'get', path: '/tasks/:id', tag: '作业', summary: '读取一项作业' },
  { method: 'patch', path: '/tasks/:id', tag: '作业', summary: '改还没打分的作业(名称、规定用时、日期)', body: taskUpdate },
  { method: 'delete', path: '/tasks/:id', tag: '作业', summary: '删除还没打分的作业' },
  { method: 'post', path: '/tasks/:id/result', tag: '作业', summary: '录入实际用时与质量并算分;preview=true 只算不存', body: taskResult },
  { method: 'post', path: '/tasks/:id/missed', tag: '作业', summary: '记为没完成(按快照扣分)', body: taskMissed },
  { method: 'post', path: '/tasks/:id/claim', tag: '作业', summary: '孩子报完成:只记申报,不加分', body: taskClaim },
  { method: 'delete', path: '/tasks/:id/claim', tag: '作业', summary: '驳回孩子的申报' },

  { method: 'get', path: '/rewards', tag: '奖励', summary: '奖励列表(附当前余额)', query: [MAC_Q, { name: 'archived', description: '1 = 连已停用的一起列' }] },
  { method: 'post', path: '/rewards', tag: '奖励', summary: '新建奖励', body: rewardCreate },
  { method: 'post', path: '/rewards/reorder', tag: '奖励', summary: '按给定顺序重排', body: reorderBody },
  { method: 'get', path: '/rewards/:id', tag: '奖励', summary: '读取一个奖励' },
  { method: 'patch', path: '/rewards/:id', tag: '奖励', summary: '改奖励', body: rewardUpdate },
  { method: 'delete', path: '/rewards/:id', tag: '奖励', summary: '删除;兑换过的改为停用,返回 result=archived' },
  { method: 'post', path: '/rewards/:id/restore', tag: '奖励', summary: '恢复已停用的奖励' },

  { method: 'post', path: '/redeem', tag: '兑换与奖惩', summary: '兑换奖励;余额不够回 409 insufficient_balance', body: redeemBody },
  { method: 'post', path: '/adjust', tag: '兑换与奖惩', summary: '手动加减分(必须写原因)', body: adjustBody },

  {
    method: 'get', path: '/ledger', tag: '流水', summary: '流水,按 id 倒序翻页;每条带当时余额',
    query: [MAC_Q, { name: 'kind', description: '按类型筛选', enum: LEDGER_KINDS }, { name: 'from', description: 'YYYY-MM-DD' },
      { name: 'to', description: 'YYYY-MM-DD' }, ...CURSOR],
  },
  { method: 'get', path: '/ledger/:id', tag: '流水', summary: '读取一笔流水' },
  { method: 'post', path: '/ledger/:id/revert', tag: '流水', summary: '撤销一笔:追加反向记录;作业打分被撤销时作业回到待完成' },

  {
    method: 'get', path: '/stats', tag: '统计', summary: '每天挣/扣/花的分、各作业完成率按时率与平均用时;默认最近 7 天,最长一年',
    query: [MAC_Q, { name: 'from', description: 'YYYY-MM-DD' }, { name: 'to', description: 'YYYY-MM-DD,默认今天' }],
  },
];

const ERROR_CODES = ['invalid', 'not_found', 'device_not_found', 'already_scored', 'archived', 'insufficient_balance',
  'already_reverted', 'not_revertible', 'read_only_key', 'idempotency_key_reused', 'unauthorized', 'not_app_device'];

const toOpenApiPath = (path: string) => path.replace(/:(\w+)/gu, '{$1}');

function jsonSchema(schema: z.ZodType): Record<string, unknown> {
  const { $schema: _drop, ...rest } = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  return rest;
}

export function buildOpenApi(basePath: string): Record<string, unknown> {
  const paths: Record<string, Record<string, unknown>> = {};
  for (const endpoint of ENDPOINTS) {
    const methods: Method[] = endpoint.method === 'patch' ? ['patch', 'put'] : [endpoint.method];
    const pathParams = [...endpoint.path.matchAll(/:(\w+)/gu)].map((m) => ({
      name: m[1], in: 'path', required: true,
      schema: { type: m[1] === 'mac' ? 'string' : 'integer' },
      ...(m[1] === 'mac' ? { description: '紧凑写法,如 4c11ae317a30' } : {}),
    }));
    const queryParams = (endpoint.query ?? []).map((q) => ({
      name: q.name, in: 'query', required: !!q.required, description: q.description,
      schema: q.enum ? { type: 'string', enum: [...q.enum] } : { type: 'string' },
    }));
    const write = endpoint.method !== 'get';
    for (const method of methods) {
      (paths[toOpenApiPath(endpoint.path)] ??= {})[method] = {
        tags: [endpoint.tag],
        summary: endpoint.summary + (method === 'put' ? '(与 PATCH 相同,部分更新)' : ''),
        ...(pathParams.length || queryParams.length ? { parameters: [...pathParams, ...queryParams] } : {}),
        ...(write ? { 'x-requires-scope': 'write' } : {}),
        ...(endpoint.body ? { requestBody: { required: true, content: { 'application/json': { schema: jsonSchema(endpoint.body) } } } } : {}),
        responses: {
          200: { description: '成功', content: { 'application/json': { schema: { type: 'object' } } } },
          ...(write ? { 400: { $ref: '#/components/responses/Error' } } : {}),
          401: { $ref: '#/components/responses/Error' },
          ...(write ? { 403: { $ref: '#/components/responses/Error' } } : {}),
          404: { $ref: '#/components/responses/Error' },
          ...(write ? { 409: { $ref: '#/components/responses/Error' } } : {}),
        },
      };
    }
  }
  return {
    openapi: '3.1.0',
    info: {
      title: '小单学分接口',
      version: '1',
      description: [
        '作业规则 → 每天布置 → 录入用时与质量算分 → 分数兑换奖励。按设备记账,一台设备就是一个孩子。',
        '',
        '约定:',
        '- 鉴权两种:① `Authorization: Bearer <密钥>`,密钥在控制台「学分 → 开放接口」创建,分只读与可写,只读密钥做写操作回 403 read_only_key;'
        + '② 家长 App 用自己的设备身份 `Device-Id` + `Client-Id`(与连引擎时同一对头),需先像设备一样绑定控制塔,且 OTA 里报 board.type = xiaodan-app。',
        '- 改动同时认 PATCH 与 PUT,都是部分更新。',
        '- 错误体 `{"error": "中文说明", "code": "机器可读代码"}`。',
        '- 列表返回 `{items, next}`,把 next 作为 before 传回去取下一页。',
        '- 写操作可带 `Idempotency-Key` 请求头(1~100 字符):同一把密钥、同一个值 24 小时内重复提交,直接回放第一次的结果,不会重复扣分。',
        '- MAC 冒号、连字符、12 位紧凑写法都认;拼进 URL 请用紧凑写法。',
        '- 规则的数值在布置作业时抄进作业快照:改规则不影响已布置的作业和已算过的分。',
        '- 余额是流水之和,可以因为惩罚变成负数;兑换必须够分。撤销是追加一条反向流水,原记录保留。',
      ].join('\n'),
    },
    servers: [{ url: basePath }],
    security: [{ bearer: [] }, { deviceId: [], clientId: [] }],
    components: {
      securitySchemes: {
        bearer: { type: 'http', scheme: 'bearer' },
        deviceId: { type: 'apiKey', in: 'header', name: 'Device-Id', description: '家长 App 的设备 MAC' },
        clientId: { type: 'apiKey', in: 'header', name: 'Client-Id', description: '家长 App 的设备密钥(64 位十六进制)' },
      },
      responses: {
        Error: {
          description: '出错',
          content: {
            'application/json': {
              schema: {
                type: 'object',
                required: ['error'],
                properties: { error: { type: 'string' }, code: { type: 'string', enum: ERROR_CODES } },
              },
            },
          },
        },
      },
    },
    paths,
  };
}

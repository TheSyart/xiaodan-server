<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { api, urlMac, type CreditApiKey } from '../../api';
import AppIcon from '../../components/AppIcon.vue';
import EmptyState from '../../components/EmptyState.vue';
import ModalDialog from '../../components/ModalDialog.vue';
import PageHeader from '../../components/PageHeader.vue';
import { useCreditChild } from '../../credits/useCreditChild';
import { confirmDialog, formatTime, promptDialog, toast, toastError } from '../../ui';

// 开放接口:给 App、手机快捷指令、脚本用的 /open/v1/credits。
// 密钥可以有多把,各自起名、分只读与可写、单独吊销;明文只在创建时显示一次。

const { mac, refresh } = useCreditChild();
const keys = ref<CreditApiKey[]>([]);
const shown = ref<{ name: string; key: string } | null>(null);
const origin = typeof window === 'undefined' ? '' : window.location.origin;
const BASE = '/open/v1/credits';

async function load() {
  try {
    keys.value = (await api.get<{ items: CreditApiKey[] }>('/credits/keys')).items;
  } catch (e) {
    toastError(e);
  }
}
onMounted(() => {
  void load();
  void refresh();
});

const active = computed(() => keys.value.filter((k) => !k.revoked_at));
const revoked = computed(() => keys.value.filter((k) => k.revoked_at));

const createOpen = ref(false);
const form = ref({ name: '', scope: 'write' as 'read' | 'write' });
async function create() {
  try {
    const data = await api.post<{ key: string; item: CreditApiKey }>('/credits/keys', { name: form.value.name.trim(), scope: form.value.scope });
    shown.value = { name: data.item.name, key: data.key };
    createOpen.value = false;
    form.value = { name: '', scope: 'write' };
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function rename(key: CreditApiKey) {
  const name = (await promptDialog({ title: '给密钥改名', confirmText: '保存', input: { label: '名称', value: key.name, maxlength: 40 } }))?.trim();
  if (!name || name === key.name) return;
  try {
    await api.patch(`/credits/keys/${key.id}`, { name });
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function revoke(key: CreditApiKey) {
  if (!(await confirmDialog({ title: `吊销「${key.name}」?`, message: '用这把密钥的 App 或快捷指令立即失效,其他密钥不受影响。吊销后不能恢复。', confirmText: '吊销', danger: true }))) return;
  try {
    await api.del(`/credits/keys/${key.id}`);
    if (shown.value?.name === key.name) shown.value = null;
    await load();
  } catch (e) {
    toastError(e);
  }
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('已复制');
  } catch {
    toast('复制失败,请手动选中复制', 'warn');
  }
}

const ENDPOINTS: [string, string, string][] = [
  ['GET', '/children', '所有硬件设备(孩子)与余额、今天完成情况、待确认申报数'],
  ['GET', '/binding', '家长 App 绑定的那台硬件;仅家长 App 设备身份可用'],
  ['PUT', '/binding', '绑定一台硬件(体 {"mac":"…"});仅家长 App 设备身份可用'],
  ['DELETE', '/binding', '解除绑定;仅家长 App 设备身份可用'],
  ['GET', '/rules?mac=', '作业模板(名字 + 参考用时);POST 新建、PATCH /rules/{id} 修改、DELETE 删除、POST /rules/{id}/restore 恢复、POST /rules/reorder 排序'],
  ['GET', '/tasks?mac=&day=', '某天的作业;带 from/to/status 查历史'],
  ['POST', '/tasks', '按模板布置;POST /tasks/custom 临时作业'],
  ['POST', '/tasks/{id}/result', '录入用时、家长给分与质量算分(preview=true 只算)'],
  ['POST', '/tasks/{id}/missed', '记为没完成,记 0 分'],
  ['POST', '/tasks/{id}/claim', '孩子报完成(不加分);DELETE 驳回'],
  ['GET', '/rewards?mac=', '奖励;增删改恢复排序同模板'],
  ['POST', '/redeem', '兑换(不够分回 409 insufficient_balance)'],
  ['POST', '/adjust', '手动加减分'],
  ['GET', '/ledger?mac=', '流水;POST /ledger/{id}/revert 撤销'],
  ['GET', '/stats?mac=&from=&to=', '统计'],
  ['GET', '/meta', '取值范围、质量档位(好 / 不好)、服务器今天'],
];

const curl = computed(() => {
  const key = shown.value?.key ?? '<你的密钥>';
  const m = mac.value ? urlMac(mac.value) : '<设备MAC>';
  const base = `${origin}${BASE}`;
  return [
    '# 所有硬件设备(孩子)与余额',
    `curl -H "Authorization: Bearer ${key}" "${base}/children"`,
    '',
    '# 今天的作业',
    `curl -H "Authorization: Bearer ${key}" "${base}/tasks?mac=${m}"`,
    '',
    '# 录入一项作业的结果;points 是家长自己给的分(0–5),quality 只有 good / poor;',
    '# Idempotency-Key 让重试不会重复记分',
    `curl -X POST -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\`,
    `  -H "Idempotency-Key: $(uuidgen)" -d '{"actual_minutes":45,"points":4,"quality":"good"}' "${base}/tasks/<id>/result"`,
    '',
    '# 兑换奖励',
    `curl -X POST -H "Authorization: Bearer ${key}" -H "content-type: application/json" \\`,
    `  -H "Idempotency-Key: $(uuidgen)" -d '{"mac":"${m}","reward_id":<id>}' "${base}/redeem"`,
  ].join('\n');
});
</script>

<template>
  <PageHeader title="开放接口" description="给 App、手机快捷指令、脚本用的学分接口,与这些页面用的是同一套。每个 App 一把密钥,丢了哪台只吊销那一把。">
    <template #actions>
      <button class="btn btn-primary btn-sm" type="button" @click="createOpen = true"><AppIcon name="plus" :size="14" /><span>新建密钥</span></button>
    </template>
  </PageHeader>

  <div v-if="shown" class="callout warn">
    <AppIcon name="alert" :size="18" />
    <div class="callout-body">
      <strong>「{{ shown.name }}」的密钥只显示这一次,请现在复制保存。</strong>
      <div class="row" style="margin-top: 8px">
        <code class="mono key-text">{{ shown.key }}</code>
        <button class="btn btn-sm" type="button" @click="copy(shown.key)"><AppIcon name="copy" :size="14" /><span>复制</span></button>
        <button class="btn btn-ghost btn-sm" type="button" @click="shown = null">我已保存</button>
      </div>
    </div>
  </div>

  <section class="card">
    <div class="card-head"><div><h2><AppIcon name="key" :size="18" />密钥</h2><p>只读密钥只能查,不能改任何数据——适合放在孩子也能碰到的设备上。</p></div></div>
    <EmptyState v-if="active.length === 0" title="还没有密钥" description="没有密钥时外部接口整组关闭。" />
    <div v-else class="table-wrap">
      <table class="table">
        <thead><tr><th>名称</th><th>开头</th><th>权限</th><th>创建</th><th>最后使用</th><th></th></tr></thead>
        <tbody>
          <tr v-for="k in active" :key="k.id">
            <td class="cell-main">{{ k.name }}</td>
            <td class="mono">{{ k.prefix }}…</td>
            <td><span class="tag" :class="k.scope === 'write' ? 'sky' : ''">{{ k.scope === 'write' ? '可写' : '只读' }}</span></td>
            <td class="nowrap">{{ formatTime(k.created_at) }}</td>
            <td class="nowrap">{{ k.last_used_at ? formatTime(k.last_used_at) : '还没用过' }}</td>
            <td class="actions">
              <button class="btn btn-ghost btn-sm" type="button" aria-label="改名" @click="rename(k)"><AppIcon name="pencil" :size="14" /></button>
              <button class="btn btn-ghost btn-sm danger" type="button" @click="revoke(k)">吊销</button>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <details v-if="revoked.length" style="margin-top: 10px">
      <summary class="muted">已吊销的 {{ revoked.length }} 把</summary>
      <ul class="muted"><li v-for="k in revoked" :key="k.id">{{ k.name }}({{ k.prefix }}…),{{ formatTime(k.revoked_at ?? '') }} 吊销</li></ul>
    </details>
  </section>

  <section class="card">
    <div class="card-head">
      <div>
        <h2><AppIcon name="link" :size="18" />接口</h2>
        <p>地址前缀 <code>{{ origin }}{{ BASE }}</code>。完整说明(每个字段的取值范围、错误代码)在
          <a :href="`${BASE}/openapi.json`" target="_blank" rel="noopener">openapi.json</a>,不需要密钥就能打开,可以直接导入 Postman、Apifox 或生成 App 的客户端代码。</p>
      </div>
    </div>
    <div class="table-wrap">
      <table class="table">
        <tbody>
          <tr v-for="[method, path, text] in ENDPOINTS" :key="method + path">
            <td class="nowrap"><span class="tag">{{ method }}</span></td>
            <td class="mono nowrap">{{ path }}</td>
            <td>{{ text }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <ul class="field-hint conventions">
      <li>鉴权:<code>Authorization: Bearer &lt;密钥&gt;</code>。只读密钥做写操作回 403 <code>read_only_key</code>。</li>
      <li>家长 App 也可以不建密钥,用它自己的设备身份(<code>Device-Id</code> + <code>Client-Id</code>,board = xiaodan-app)调这些接口;这时 <code>mac</code> 必须是它绑定过的那台硬件,否则回 403 <code>not_bound_child</code>,还没绑定回 409 <code>no_bound_child</code>,想绑第二台回 409 <code>second_hardware_not_supported</code>。用密钥的脚本、快捷指令不受这条限制,一律显式传 <code>mac</code>。</li>
      <li>修改同时认 PATCH 和 PUT,都是部分更新;错误体 <code>{"error": "中文说明", "code": "代码"}</code>。</li>
      <li>列表返回 <code>{items, next}</code>,把 <code>next</code> 当作 <code>before</code> 传回去取下一页。</li>
      <li>写操作带 <code>Idempotency-Key</code>(1~100 个字符):网络抖动重试时回放第一次的结果,不会重复记分、重复扣分。</li>
      <li>MAC 用去掉冒号的写法,如 <code>4c11ae317a30</code>。</li>
    </ul>
    <pre class="code-block">{{ curl }}</pre>
    <p class="field-hint">外部接口在公网能打通,还需要在运维面板给 <code>/open/</code> 放行统一登录(见 README「学分奖惩」一节)。</p>
  </section>

  <ModalDialog :open="createOpen" title="新建密钥" @close="createOpen = false">
    <div class="form-grid">
      <label class="field"><span class="field-label">名称</span><input v-model="form.name" class="input" type="text" maxlength="40" placeholder="妈妈的手机" /></label>
      <label class="field">
        <span class="field-label">权限</span>
        <select v-model="form.scope" class="select">
          <option value="write">可写:能打分、兑换、加减分</option>
          <option value="read">只读:只能查</option>
        </select>
      </label>
    </div>
    <template #footer>
      <button class="btn" type="button" @click="createOpen = false">取消</button>
      <button class="btn btn-primary" type="button" @click="create">创建</button>
    </template>
  </ModalDialog>
</template>

<style scoped>
.key-text { word-break: break-all; background: var(--paper); padding: 4px 8px; border-radius: 6px; }
.conventions { margin: 12px 0; padding-left: 18px; display: flex; flex-direction: column; gap: 4px; }
</style>

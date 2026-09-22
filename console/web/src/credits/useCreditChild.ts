// 学分各子页共用的「当前是哪个孩子」。一台设备就是一个孩子。
//
// 模块级的单例:在「今日作业」选了乐乐,切到「兑换奖励」还是乐乐。选择记在 localStorage
// (读写都包 try/catch——隐私模式、被清掉的站点数据下取不到就退回第一台,页面照常能用)。

import { computed, ref, watch } from 'vue';
import { api, type CreditChild } from '../api';

const STORAGE_KEY = 'xiaodan.credits.child';

function readSaved(): string {
  try {
    return localStorage.getItem(STORAGE_KEY) ?? '';
  } catch {
    return '';
  }
}

const children = ref<CreditChild[]>([]);
const mac = ref(readSaved());
const today = ref('');
const loaded = ref(false);
const loadError = ref('');

watch(mac, (value) => {
  try {
    if (value) localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* 存不下就算了,下次退回第一台 */
  }
});

/** 重新拉孩子列表(余额、今天完成情况、待确认申报数);改了分数的操作之后都调一下 */
async function refresh(): Promise<void> {
  try {
    const data = await api.get<{ items: CreditChild[]; today: string }>('/credits/children');
    children.value = data.items;
    today.value = data.today;
    if (!data.items.some((child) => child.mac === mac.value)) mac.value = data.items[0]?.mac ?? '';
    loadError.value = '';
  } catch (e) {
    loadError.value = (e as Error).message;
  } finally {
    loaded.value = true;
  }
}

export function useCreditChild() {
  return {
    children,
    mac,
    today,
    loaded,
    loadError,
    child: computed(() => children.value.find((item) => item.mac === mac.value) ?? null),
    refresh,
  };
}

export const signed = (n: number | null | undefined) => (n == null ? '' : n > 0 ? `+${n}` : String(n));

export const QUALITY = [
  { key: 'excellent', label: '优' }, { key: 'good', label: '良' }, { key: 'fair', label: '中' }, { key: 'poor', label: '差' },
] as const;
export const qualityLabel = (key: string | null) => QUALITY.find((q) => q.key === key)?.label ?? '';

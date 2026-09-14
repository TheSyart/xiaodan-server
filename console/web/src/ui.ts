// 页面共用的小工具:轻提示、确认框、时间格式、复制、主题。
// 状态都是模块级的 reactive 单例,由 App.vue 里的 ToastHost 与 ConfirmHost 渲染,
// 任何页面直接调函数即可,不需要层层传递。

import { reactive } from 'vue';

// ---------------------------------------------------------------- 轻提示

export type ToastKind = 'success' | 'error' | 'info' | 'warn';

export interface ToastItem {
  id: number;
  kind: ToastKind;
  message: string;
}

export const toasts = reactive<ToastItem[]>([]);
let nextToastId = 1;

/** 右下角的提示,默认 3 秒后自己消失;错误多留一会儿,方便看清。 */
export function toast(message: string, kind: ToastKind = 'success', ms?: number): void {
  const id = nextToastId++;
  toasts.push({ id, kind, message });
  while (toasts.length > 4) toasts.shift();
  const life = ms ?? (kind === 'error' || kind === 'warn' ? 6500 : 3200);
  if (life > 0) window.setTimeout(() => dismissToast(id), life);
}

export function dismissToast(id: number): void {
  const index = toasts.findIndex((item) => item.id === id);
  if (index >= 0) toasts.splice(index, 1);
}

export function toastError(error: unknown): void {
  toast(error instanceof Error ? error.message : String(error), 'error');
}

// ---------------------------------------------------------------- 确认框

export interface DialogInput {
  label: string;
  value?: string;
  placeholder?: string;
  maxlength?: number;
}

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  input?: DialogInput;
}

interface DialogState {
  open: boolean;
  title: string;
  message: string;
  confirmText: string;
  cancelText: string;
  danger: boolean;
  input: DialogInput | null;
  value: string;
}

export const dialogState = reactive<DialogState>({
  open: false,
  title: '',
  message: '',
  confirmText: '',
  cancelText: '',
  danger: false,
  input: null,
  value: '',
});

let resolveDialog: ((ok: boolean) => void) | null = null;

function openDialog(options: ConfirmOptions): Promise<boolean> {
  resolveDialog?.(false);   // 同一时刻只有一个确认框:新的顶掉旧的
  Object.assign(dialogState, {
    open: true,
    title: options.title,
    message: options.message ?? '',
    confirmText: options.confirmText ?? '确定',
    cancelText: options.cancelText ?? '取消',
    danger: options.danger === true,
    input: options.input ?? null,
    value: options.input?.value ?? '',
  });
  return new Promise((resolve) => {
    resolveDialog = resolve;
  });
}

export function closeDialog(ok: boolean): void {
  const resolve = resolveDialog;
  resolveDialog = null;
  dialogState.open = false;
  resolve?.(ok);
}

/** 替代 window.confirm。用户确认返回 true。 */
export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  return openDialog(options);
}

/** 替代 window.prompt。取消返回 null。 */
export async function promptDialog(options: ConfirmOptions & { input: DialogInput }): Promise<string | null> {
  return (await openDialog(options)) ? dialogState.value : null;
}

// ---------------------------------------------------------------- 时间

/** SQLite 的 datetime('now') 是 UTC,但不带时区标记,要补上 Z 再解析。 */
export function parseDbTime(value: string): Date {
  return new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`);
}

export function formatTime(value: string | null | undefined): string {
  if (!value) return '';
  return parseDbTime(value).toLocaleString('zh-CN', { hour12: false });
}

export function relativeTime(value: string | null | undefined): string {
  if (!value) return '从未';
  const date = parseDbTime(value);
  const diff = Date.now() - date.getTime();
  if (diff < 60_000) return '刚刚';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return date.toLocaleDateString('zh-CN');
}

// ---------------------------------------------------------------- 复制

export async function copyText(text: string, what = '内容'): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    toast(`已复制${what}`);
  } catch {
    toast('浏览器不允许自动复制,请手动选中后复制。', 'warn');
  }
}

// ---------------------------------------------------------------- 主题

export type Theme = 'light' | 'dark';
const THEME_KEY = 'xiaodan-theme';

export function storedTheme(): Theme | null {
  try {
    const value = localStorage.getItem(THEME_KEY);
    return value === 'light' || value === 'dark' ? value : null;
  } catch {
    return null;
  }
}

export function effectiveTheme(): Theme {
  return storedTheme() ?? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}

/** 传 null 表示跟随系统。 */
export function applyTheme(theme: Theme | null): void {
  const root = document.documentElement;
  if (theme) root.dataset.theme = theme;
  else delete root.dataset.theme;
  try {
    if (theme) localStorage.setItem(THEME_KEY, theme);
    else localStorage.removeItem(THEME_KEY);
  } catch {
    /* 隐私模式下写不进去也无妨 */
  }
}

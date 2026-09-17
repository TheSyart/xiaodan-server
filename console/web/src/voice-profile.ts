// 音色设置在页面上的计算:合成语气指令、数单位。规则与控制塔 console/src/voice/profile.ts 一致,
// 词表由 /api/catalog 下发。

import type { VoiceCatalog, VoiceProfile } from './api';

export function instructionUnits(text: string): number {
  let units = 0;
  for (const ch of text) units += ch.charCodeAt(0) > 0x7f ? 2 : 1;
  return units;
}

/** 合成前(未截断)的语气指令:方言 → 固定语气 → 补充说明 */
export function composeInstruction(profile: VoiceProfile, catalog: VoiceCatalog): string {
  const parts: string[] = [];
  if (profile.dialect && profile.language === '中文') parts.push(`请用${profile.dialect}表达`);
  for (const id of profile.tone_tags) {
    const chip = catalog.tone_chips.find((item) => item.id === id);
    if (chip) parts.push(chip.phrase);
  }
  if (profile.tone_text.trim()) parts.push(profile.tone_text.trim());
  return parts.join(',');
}

export function profileOf(source: VoiceProfile): VoiceProfile {
  return {
    language: source.language, dialect: source.dialect, volume: source.volume, rate: source.rate, pitch: source.pitch,
    tone_tags: [...source.tone_tags], tone_text: source.tone_text, emotion_tags: [...source.emotion_tags],
  };
}

export function profileSummary(profile: VoiceProfile, catalog: VoiceCatalog | undefined): string {
  const parts = [profile.language];
  if (profile.dialect) parts.push(profile.dialect);
  if (profile.rate !== 1) parts.push(`语速 ${profile.rate}`);
  if (profile.volume !== 50) parts.push(`音量 ${profile.volume}`);
  if (profile.pitch !== 1) parts.push(`音调 ${profile.pitch}`);
  const tones = profile.tone_tags.map((id) => catalog?.tone_chips.find((chip) => chip.id === id)?.label).filter(Boolean);
  if (tones.length) parts.push(tones.join('、'));
  if (profile.tone_text) parts.push(profile.tone_text);
  if (profile.emotion_tags.length) parts.push(`情感标签 ${profile.emotion_tags.length} 个`);
  return parts.join(' · ');
}

/** 去掉情感标签(显示用) */
export function stripInlineTags(text: string): string {
  return text.replace(/\[([a-z][a-z ]{0,30})\]/gu, '');
}

export function inlineTagsOf(text: string): string[] {
  return [...new Set([...text.matchAll(/\[([a-z][a-z ]{0,30})\]/gu)].map((match) => match[1]!))];
}

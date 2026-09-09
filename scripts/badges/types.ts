/**
 * 徽章管线类型与配置契约
 */

// Catppuccin Macchiato 配色
export const PAL = {
  pink: "f5bde6",
  mauve: "c6a0f6",
  red: "ed8796",
  peach: "f5a97f",
  yellow: "eed49f",
  green: "a6da95",
  teal: "8bd5ca",
  sky: "91d7e3",
  sapphire: "7dc4e4",
  blue: "8aadf4",
  lavender: "b7bdf8",
  text: "cad3f5",
  surface0: "363a4f",
} as const;

export type PalKey = keyof typeof PAL;

export const LABEL = PAL.surface0;
export const LOGO = PAL.text;

export const GAP = 6;
export const HEIGHT = 28;
export const MAX_ROW_WIDTH = 860;
export const DEFAULT_CONCURRENCY = 10;

export type BadgeItem = [label: string, colorKey: PalKey, logo?: string | null];

export interface BadgeGroup {
  slug: string;
  title: string;
  items: BadgeItem[];
}

export function isPalKey(color: string): color is PalKey {
  return Object.hasOwn(PAL, color);
}

export class BadgeFetchError extends Error {
  constructor(public readonly url: string, message: string) {
    super(`获取徽章失败 [${url}]: ${message}`);
    this.name = "BadgeFetchError";
  }
}

export class BadgeMissingError extends Error {
  constructor(public readonly url: string) {
    super(`徽章资产未预取或缺失 [${url}]，排版中断`);
    this.name = "BadgeMissingError";
  }
}

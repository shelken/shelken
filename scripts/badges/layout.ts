import {
  GAP,
  HEIGHT,
  MAX_ROW_WIDTH,
  type BadgeItem,
  BadgeMissingError,
} from "./types";
import { getBadgeUrl } from "./store";

/**
 * 纯文本解析 SVG，提取宽度、高度与内部子图元
 */
export function parseSvg(svg: string): [width: number, height: number, inner: string] {
  const m = svg.match(/<svg\b([^>]*)>([\s\S]*)<\/svg\s*>/i);
  if (!m) throw new Error("invalid svg");

  const attrs = m[1];
  const inner = m[2].trim();

  const wm = attrs.match(/\bwidth="([\d.]+)"/);
  const hm = attrs.match(/\bheight="([\d.]+)"/);
  if (!wm || !hm) throw new Error(`missing width/height in ${attrs.slice(0, 80)}`);

  return [parseFloat(wm[1]), parseFloat(hm[1]), inner];
}

/**
 * 纯同步几何流式排版：依据 badgeMap 进行坐标换行计算。
 * Fail-fast 契约：若缺失任一 badge，直接抛出 BadgeMissingError。
 */
export function composeBadges(
  items: BadgeItem[],
  badgeMap: Map<string, string>
): string {
  const parts: string[] = [];
  let x = 0.0;
  let y = 0.0;
  let rowH = Number(HEIGHT);
  let maxW = 0.0;

  for (const item of items) {
    const url = getBadgeUrl(item);
    const raw = badgeMap.get(url);
    if (!raw) {
      throw new BadgeMissingError(url);
    }

    const [w, h, inner] = parseSvg(raw);
    rowH = Math.max(rowH, h);

    if (x > 0 && x + w > MAX_ROW_WIDTH) {
      maxW = Math.max(maxW, x - GAP);
      y += rowH + GAP;
      x = 0.0;
      rowH = h;
    }

    parts.push(
      `<svg x="${x.toFixed(2)}" y="${y.toFixed(2)}" width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${inner}</svg>`
    );
    x += w + GAP;
  }

  maxW = Math.max(maxW, items.length > 0 ? x - GAP : 0);
  const totalH = y + rowH;
  const body = parts.join("\n");

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${MAX_ROW_WIDTH} ${totalH.toFixed(2)}" width="${MAX_ROW_WIDTH}" height="${totalH.toFixed(2)}" role="img" aria-label="tech badges">\n` +
    `${body}\n` +
    `</svg>\n`
  );
}

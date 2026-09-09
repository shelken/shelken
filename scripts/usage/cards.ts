import {
  type Client,
  type DailyRecord,
  type AggregateUsage,
  ACCENT,
  TITLE,
  PALETTE,
  USAGE_CONFIG,
} from "./types";
import {
  cleanModelName,
  dayTokens,
  filterLastNDays,
  fmtTokens,
  rankModels,
  sumTokens,
} from "./store";

export interface TextOptions {
  fill: string;
  size: number;
  weight?: string;
  anchor?: string;
  spacing?: string;
  font?: string;
}

export function escapeXml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function svgText(x: number, y: number, body: string, opts: TextOptions): string {
  let attrs = `x="${x}" y="${y}" fill="${opts.fill}" font-size="${opts.size}"`;
  if (opts.weight !== undefined) {
    if (opts.weight) attrs += ` font-weight="${opts.weight}"`;
  } else {
    attrs += ` font-weight="400"`;
  }
  attrs += ` font-family="${opts.font || PALETTE.font}"`;
  if (opts.anchor) attrs += ` text-anchor="${opts.anchor}"`;
  if (opts.spacing) attrs += ` letter-spacing="${opts.spacing}"`;
  return `<text ${attrs}>${escapeXml(body)}</text>`;
}

/**
 * 构造单客户端卡片 SVG（如 omp.svg）
 */
export function buildClientSvg(days: DailyRecord[], client: Client): string {
  const title = TITLE[client];
  const A = ACCENT[client];
  const d7 = filterLastNDays(days, 7);
  const d40 = filterLastNDays(days, 40);
  const total = sumTokens(days);
  const t7 = sumTokens(d7);
  const t40 = sumTokens(d40);

  const cfg = USAGE_CONFIG.clientCard;
  const topModels = rankModels(days, cfg.topModels);

  const dates = days.map((d) => d.date).sort();
  const fr = dates[0] || "—";
  const to = dates[dates.length - 1] || "—";
  const dateStr = fr === to ? fr : `${fr} · ${to}`;

  const nDays = days.length || 1;
  const activeDays = days.filter((d) => dayTokens(d) > 0).length;
  const avgDay = Math.floor(total / nDays);
  const peakDay = Math.max(...days.map((d) => dayTokens(d)), 0);

  const inp = days.reduce((a, d) => a + d.inputTokens, 0);
  const out = days.reduce((a, d) => a + d.outputTokens, 0);
  const cr = days.reduce((a, d) => a + d.cacheReadTokens, 0);
  const cw = days.reduce((a, d) => a + d.cacheCreationTokens, 0);
  const denom = inp + cr;
  const cachePct = denom > 0 ? Math.round((100 * cr) / denom) : 0;

  const totalDenom = cr + cw + inp + out;
  const compBarW = 215;
  const crPct = totalDenom > 0 ? Math.round((100 * cr) / totalDenom) : 0;
  const inpPct = totalDenom > 0 ? Math.round((100 * inp) / totalDenom) : 0;
  const outPct = totalDenom > 0 ? Math.max(0, 100 - crPct - inpPct) : 0;
  let crSegW = totalDenom > 0 ? Math.floor((cr * compBarW) / totalDenom) : 0;
  let inpSegW = totalDenom > 0 ? Math.floor((inp * compBarW) / totalDenom) : 0;
  let outSegW = compBarW - crSegW - inpSegW;
  if (cr > 0 && crSegW < 3) crSegW = 3;
  if (inp > 0 && inpSegW < 3) inpSegW = 3;
  if (out > 0 && outSegW < 3) outSegW = 3;

  const W = cfg.width;
  const H = cfg.height;

  const parts: string[] = [
    `<rect width="${W - 1}" height="${H - 1}" x="0.5" y="0.5" rx="6" fill="${PALETTE.bg}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    svgText(30, 36, title, { fill: A, size: 17, weight: "700" }),
    svgText(W - 30, 35, "@shelken", { fill: PALETTE.user, size: 13, weight: "600", anchor: "end" }),
    svgText(W - 30, 50, dateStr, { fill: PALETTE.foot, size: 11, anchor: "end" }),
    `<line x1="250" y1="62" x2="250" y2="214" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `<line x1="510" y1="62" x2="510" y2="214" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    // Col 1: ALL-TIME (30 ~ 230)
    svgText(30, 74, "ALL-TIME", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.2" }),
    svgText(30, 112, fmtTokens(total), { fill: A, size: 38, weight: "800" }),
    `<rect x="30" y="122" width="144" height="18" rx="4" fill="${PALETTE.barBg}"/>`,
    svgText(38, 135, "tokens · ", { fill: PALETTE.sub, size: 11 }),
    svgText(79, 135, `${cachePct}% cache-hit`, { fill: A, size: 11, weight: "700" }),
    `<line x1="30" y1="148" x2="230" y2="148" stroke="${PALETTE.stroke}" stroke-dasharray="3 3"/>`,
    svgText(30, 168, "Active days", { fill: PALETTE.sub, size: 12 }),
    svgText(230, 168, String(activeDays), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(30, 187, "Avg / day", { fill: PALETTE.sub, size: 12 }),
    svgText(230, 187, fmtTokens(avgDay), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(30, 206, "Peak day", { fill: PALETTE.sub, size: 12 }),
    svgText(230, 206, fmtTokens(peakDay), { fill: A, size: 12, weight: "700", anchor: "end" }),
    // Col 2: TOKEN COMPOSITION & MIX (275 ~ 490)
    svgText(275, 74, "TOKEN COMPOSITION", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.2" }),
    `<defs><clipPath id="${client}-comp-clip"><rect x="275" y="86" width="${compBarW}" height="6" rx="3"/></clipPath></defs>`,
    `<g clip-path="url(#${client}-comp-clip)">` +
      `<rect x="275" y="86" width="${compBarW}" height="6" fill="${PALETTE.barBg}"/>` +
      `<rect x="275" y="86" width="${crSegW}" height="6" fill="${A}"/>` +
      `<rect x="${275 + crSegW}" y="86" width="${inpSegW}" height="6" fill="#8aadf4"/>` +
      `<rect x="${275 + crSegW + inpSegW}" y="86" width="${outSegW}" height="6" fill="#a6da95"/>` +
    `</g>`,
    `<circle cx="279" cy="102" r="3" fill="${A}"/>`,
    svgText(286, 105, `Cache ${crPct}%`, { fill: PALETTE.sub, size: 10 }),
    `<circle cx="355" cy="102" r="3" fill="#8aadf4"/>`,
    svgText(362, 105, `In ${inpPct}%`, { fill: PALETTE.sub, size: 10 }),
    `<circle cx="417" cy="102" r="3" fill="#a6da95"/>`,
    svgText(424, 105, `Out ${outPct}%`, { fill: PALETTE.sub, size: 10 }),
    svgText(275, 124, "Output", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 124, fmtTokens(out), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 141, "Input", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 141, fmtTokens(inp), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 158, "Cache read", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 158, fmtTokens(cr), { fill: A, size: 12, weight: "700", anchor: "end" }),
    `<line x1="275" y1="168" x2="490" y2="168" stroke="${PALETTE.stroke}" stroke-dasharray="3 3"/>`,
    svgText(275, 187, "Recent 7d", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 187, fmtTokens(t7), { fill: A, size: 12, weight: "700", anchor: "end" }),
    svgText(275, 206, "Recent 40d", { fill: PALETTE.sub, size: 12 }),
    svgText(490, 206, fmtTokens(t40), { fill: A, size: 12, weight: "700", anchor: "end" }),
    // Col 3: TOP 5 MODELS (535 ~ 816)
    svgText(535, 74, "TOP 5 MODELS", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.2" }),
  ];

  const maxModelTokens = topModels[0]?.[1] || 1;

  if (topModels.length === 0) {
    parts.push(svgText(535, 120, "No model breakdown available", { fill: PALETTE.foot, size: 12 }));
  } else {
    const barX = 705;
    const barW = 55;
    const spacingY = topModels.length >= 5 ? 27 : topModels.length === 4 ? 30 : topModels.length === 3 ? 36 : 40;
    let yPos = topModels.length >= 5 ? 98 : topModels.length === 4 ? 100 : topModels.length === 3 ? 106 : 110;

    for (const [name, tok] of topModels) {
      const displayName = name.length <= 21 ? name : `${name.slice(0, 20)}…`;
      const ratio = maxModelTokens > 0 ? tok / maxModelTokens : 0;
      const fillW = Math.max(2, Math.floor(barW * ratio));

      parts.push(
        svgText(535, yPos, displayName, { fill: PALETTE.user, size: 12, weight: "500" }),
        `<rect x="${barX}" y="${yPos - 8}" width="${barW}" height="6" rx="3" fill="${PALETTE.barBg}"/>`,
        `<rect x="${barX}" y="${yPos - 8}" width="${fillW}" height="6" rx="3" fill="${A}"/>`,
        svgText(816, yPos, fmtTokens(tok), { fill: A, size: 12, weight: "700", anchor: "end" })
      );
      yPos += spacingY;
    }
  }

  return (
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<svg width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(title)}">\n` +
    parts.join("\n") +
    "\n</svg>\n"
  );
}

/**
 * 构造 2×2 历史生态归档卡片 SVG（history.svg）
 */
export function buildHistorySvg(allClientDays: Record<Client, DailyRecord[]>): string {
  const daysMap = allClientDays;
  const cfg = USAGE_CONFIG.historyCard;
  const width = cfg.width;
  const height = cfg.height;

  let totalTokensAll = 0;
  const allDates: string[] = [];
  const uniqueActiveDates = new Set<string>();
  for (const c of cfg.clients) {
    const days = daysMap[c] || [];
    for (const d of days) {
      totalTokensAll += dayTokens(d);
      if (d.date) {
        allDates.push(d.date);
        if (dayTokens(d) > 0) uniqueActiveDates.add(d.date);
      }
    }
  }
  allDates.sort();
  const minDate = allDates[0] || "";
  const maxDate = allDates[allDates.length - 1] || "";
  const totalActiveDays = uniqueActiveDates.size;

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(cfg.title)}">`,
    `  <rect width="${width - 1}" height="${height - 1}" x="0.5" y="0.5" rx="6" fill="${PALETTE.bg}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `  ${svgText(30, 34, cfg.title, { fill: "#c6a0f6", size: 16, weight: "700" })}`,
    `  ${svgText(816, 32, cfg.user, { fill: PALETTE.user, size: 13, weight: "600", anchor: "end" })}`,
    `  ${svgText(816, 47, `${minDate} · ${maxDate}`, { fill: PALETTE.foot, size: 11, anchor: "end" })}`,
    `  <text x="30" y="52" font-size="12" font-family="${PALETTE.font}">`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">${fmtTokens(totalTokensAll)}</tspan><tspan fill="${PALETTE.foot}"> tokens · </tspan>`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">4</tspan><tspan fill="${PALETTE.foot}"> clients · </tspan>`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">${totalActiveDays}</tspan><tspan fill="${PALETTE.foot}"> active days</tspan>`,
    `  </text>`,
    `  <line x1="30" y1="${cfg.headerLineY}" x2="816" y2="${cfg.headerLineY}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `  <line x1="${cfg.dividerX}" y1="${cfg.headerLineY}" x2="${cfg.dividerX}" y2="${height - 16}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `  <line x1="30" y1="${cfg.dividerY}" x2="816" y2="${cfg.dividerY}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
  ];

  for (const { client: c, x: qx, y: qy } of cfg.coordinates) {
    const days = daysMap[c] || [];
    const total = sumTokens(days);
    const nDays = days.length || 1;
    const activeDays = days.filter((d) => dayTokens(d) > 0).length;
    const avgDay = Math.floor(total / nDays);
    const peakDay = Math.max(...days.map((d) => dayTokens(d)), 0);

    const inp = days.reduce((acc, d) => acc + (d.inputTokens || 0), 0);
    const out = days.reduce((acc, d) => acc + (d.outputTokens || 0), 0);
    const cr = days.reduce((acc, d) => acc + (d.cacheReadTokens || 0), 0);
    const cw = days.reduce((acc, d) => acc + (d.cacheCreationTokens || 0), 0);
    const denom = inp + out + cr + cw;
    const cacheHit = denom > 0 ? `${Math.round((cr / denom) * 100)}%` : "-";

    const dates = days.map((d) => d.date).sort();
    const dSpan = dates.length ? `${dates[0]} · ${dates[dates.length - 1]}` : "-";

    const topModels = rankModels(days, cfg.topModels);
    const maxModelTok = topModels[0]?.[1] || 1;

    const accent = ACCENT[c];
    const title = TITLE[c];

    // --- 左子栏：核心指标与用量 ---
    lines.push(
      `  <circle cx="${qx + 5}" cy="${qy + 8}" r="4.5" fill="${accent}"/>`,
      `  ${svgText(qx + 16, qy + 12, title, { fill: accent, size: 13, weight: "700" })}`,
      `  ${svgText(qx, qy + 44, fmtTokens(total), { fill: PALETTE.text, size: 26, weight: "800" })}`,
      `  <rect x="${qx}" y="${qy + 54}" width="135" height="18" rx="4" fill="${PALETTE.barBg}"/>`,
      `  ${svgText(qx + 6, qy + 67, "tokens · ", { fill: PALETTE.sub, size: 10 })}`,
      `  ${svgText(qx + 46, qy + 67, `${cacheHit} cache-hit`, { fill: accent, size: 10, weight: "700" })}`,
      `  <line x1="${qx}" y1="${qy + 84}" x2="${qx + 135}" y2="${qy + 84}" stroke="${PALETTE.stroke}" stroke-dasharray="2 2"/>`,
      `  ${svgText(qx, qy + 106, "Active days", { fill: PALETTE.sub, size: 11 })}`,
      `  ${svgText(qx + 135, qy + 106, String(activeDays), { fill: accent, size: 11, weight: "700", anchor: "end" })}`,
      `  ${svgText(qx, qy + 127, "Avg / day", { fill: PALETTE.sub, size: 11 })}`,
      `  ${svgText(qx + 135, qy + 127, fmtTokens(avgDay), { fill: accent, size: 11, weight: "700", anchor: "end" })}`,
      `  ${svgText(qx, qy + 148, "Peak day", { fill: PALETTE.sub, size: 11 })}`,
      `  ${svgText(qx + 135, qy + 148, fmtTokens(peakDay), { fill: accent, size: 11, weight: "700", anchor: "end" })}`,
      `  <line x1="${qx + 146}" y1="${qy + 16}" x2="${qx + 146}" y2="${qy + 152}" stroke="${PALETTE.stroke}" stroke-dasharray="2 2" opacity="0.6"/>`
    );

    // --- 右子栏：TOP 5 MODELS + 日期区间 ---
    const mx = qx + 158;
    lines.push(
      `  ${svgText(mx, qy + 12, "TOP 5 MODELS", { fill: PALETTE.foot, size: 10, weight: "700", spacing: "1.1" })}`,
      `  ${svgText(qx + cfg.quadrantWidth, qy + 12, dSpan, { fill: PALETTE.foot, size: 10, anchor: "end" })}`
    );

    let my = qy + 36;
    const barMaxW = 46;
    for (const [mName, mTok] of topModels) {
      const displayName = mName.length <= 17 ? mName : `${mName.slice(0, 16)}…`;
      const barW = Math.max(2, Math.round(barMaxW * (mTok / maxModelTok)));
      lines.push(
        `  ${svgText(mx, my + 8, displayName, { fill: PALETTE.user, size: 11, weight: "500" })}`,
        `  <rect x="${mx + 114}" y="${my}" width="${barMaxW}" height="6" rx="3" fill="${PALETTE.barBg}"/>`,
        `  <rect x="${mx + 114}" y="${my}" width="${barW}" height="6" rx="3" fill="${accent}"/>`,
        `  ${svgText(qx + cfg.quadrantWidth, my + 8, fmtTokens(mTok), { fill: accent, size: 11, weight: "700", anchor: "end" })}`
      );
      my += 26;
    }
  }

  lines.push("</svg>\n");
  return lines.join("\n");
}

/**
 * 构造全周期活跃图谱 SVG（harness.svg）
 */
export function buildHarnessSvg(
  clientDays: Record<Client, DailyRecord[]>,
  agg: AggregateUsage
): string {
  if (!agg) return "";

  const {
    dailyTokens,
    clientDailyTokens,
    startDate,
    latestDate,
    startDateStr,
    latestDateStr,
    totalTokens,
    activeDays,
    currentStreak,
    maxStreak,
  } = agg;

  const monthsLabels: [number, string][] = [];
  const monthsSeen: Record<string, number> = {};
  const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let wIdx = 0;
  for (let cur = new Date(startDate); cur <= latestDate; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const dW = cur.getUTCDay();
    if (cur.getUTCDate() === 1 || cur.getTime() === startDate.getTime()) {
      const mStr = monthNames[cur.getUTCMonth()];
      if (monthsSeen[mStr] === undefined || wIdx - monthsSeen[mStr] >= 3) {
        monthsLabels.push([wIdx, mStr]);
        monthsSeen[mStr] = wIdx;
      }
    }
    if (dW === 6) {
      wIdx++;
    }
  }

  const cardTitle = "Harness";
  const harnessFont = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif";

  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg width="846" height="215" viewBox="0 0 846 215" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${escapeXml(cardTitle)}">`,
    `  <rect width="845" height="214" x="0.5" y="0.5" rx="6" fill="${PALETTE.bg}" stroke="${PALETTE.stroke}" stroke-width="1"/>`,
    `  ${svgText(30, 33, cardTitle, { fill: "#c6a0f6", size: 16, weight: "700", font: harnessFont })}`,
    `  ${svgText(816, 32, "@shelken", { fill: PALETTE.user, size: 13, weight: "600", anchor: "end", font: harnessFont })}`,
    `  ${svgText(816, 47, `${startDateStr} · ${latestDateStr}`, { fill: PALETTE.foot, size: 11, anchor: "end", font: harnessFont, weight: "400" })}`,
    `  <text x="30" y="52" font-size="12" font-family="${harnessFont}">`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">${fmtTokens(totalTokens)}</tspan><tspan fill="${PALETTE.foot}"> tokens · </tspan>`,
    `    <tspan fill="${PALETTE.text}" font-weight="700">${activeDays}</tspan><tspan fill="${PALETTE.foot}"> active days · </tspan>`,
    `    <tspan fill="#c6a0f6" font-weight="700">${currentStreak}d</tspan><tspan fill="${PALETTE.foot}"> streak (max ${maxStreak}d)</tspan>`,
    "  </text>",
  ];

  for (const [w, m] of monthsLabels) {
    const x = 52 + w * 14;
    lines.push(`  ${svgText(x, 70, m, { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`);
  }

  lines.push(
    `  ${svgText(30, 99, "Mon", { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`,
    `  ${svgText(30, 127, "Wed", { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`,
    `  ${svgText(30, 155, "Fri", { fill: PALETTE.foot, size: 10, weight: "500", font: harnessFont })}`
  );

  const avgTokens = activeDays > 0 ? totalTokens / activeDays : 1;
  wIdx = 0;

  for (let cur = new Date(startDate); cur <= latestDate; cur.setUTCDate(cur.getUTCDate() + 1)) {
    const dW = cur.getUTCDay();
    const iso = cur.toISOString().slice(0, 10);
    const tok = dailyTokens[iso] || 0;
    const x = 52 + wIdx * 14;
    const y = 78 + dW * 14;

    if (tok <= 0) {
      lines.push(
        `  <rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="${PALETTE.barBg}"><title>${iso}: Inactive</title></rect>`
      );
    } else {
      const ratio = tok / avgTokens;
      let tierName: string;
      let opacity: number;

      if (ratio < 0.4) {
        tierName = "Light (< 0.5× avg)";
        opacity = 0.35;
      } else if (ratio < 1.0) {
        tierName = "Moderate (~1× avg)";
        opacity = 0.6;
      } else if (ratio < 1.8) {
        tierName = "Elevated (~1.5× avg)";
        opacity = 0.85;
      } else {
        tierName = "Peak (> 2× avg)";
        opacity = 1.0;
      }

      const clientMap = clientDailyTokens[iso] || {};
      const topClient =
        (Object.entries(clientMap).sort((a, b) => b[1] - a[1])[0]?.[0] as Client) || "omp";
      const clientLabel = TITLE[topClient] || topClient;
      const tip = `${iso}: ${tierName} · ${clientLabel}`;
      const baseColor = ACCENT[topClient] || "#c6a0f6";

      lines.push(
        `  <rect x="${x}" y="${y}" width="11" height="11" rx="2" fill="${baseColor}" fill-opacity="${opacity}"><title>${escapeXml(tip)}</title></rect>`
      );
    }

    if (dW === 6) {
      wIdx++;
    }
  }

  const legends: [Client, string, number][] = [
    ["omp", "OMP", 102],
    ["pi", "Pi", 160],
    ["claude", "Claude", 200],
    ["codex", "Codex", 265],
    ["opencode", "OpenCode", 330],
  ];

  lines.push(`  ${svgText(30, 198, "Harness:", { fill: PALETTE.foot, size: 11, font: harnessFont, weight: "" })}`);
  for (const [c, label, cx] of legends) {
    lines.push(
      `  <circle cx="${cx}" cy="194" r="4.5" fill="${ACCENT[c]}"/>`,
      `  ${svgText(cx + 10, 198, label, { fill: PALETTE.text, size: 11, font: harnessFont, weight: "" })}`
    );
  }

  lines.push(
    `  ${svgText(636, 198, "Intensity:", { fill: PALETTE.foot, size: 11, font: harnessFont, weight: "" })}`,
    `  ${svgText(690, 198, "< 0.5×", { fill: PALETTE.foot, size: 10, font: harnessFont, weight: "" })}`,
    '  <rect x="726" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.35"/>',
    '  <rect x="740" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.60"/>',
    '  <rect x="754" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="0.85"/>',
    '  <rect x="768" y="189" width="11" height="11" rx="2" fill="#c6a0f6" fill-opacity="1.0"/>',
    `  ${svgText(784, 198, "> 2× avg", { fill: PALETTE.foot, size: 10, font: harnessFont, weight: "" })}`,
    "</svg>\n"
  );

  return lines.join("\n");
}

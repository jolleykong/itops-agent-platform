/**
 * 机房监控色彩方案定义
 * - 4 套方案：deepsea 深海蓝（默认，原有风格）/ graphite 石墨灰 / terminal 终端绿 / paper 素白浅色
 * - 选择持久化于 localStorage 'dc:color-scheme'，2D/3D/正视图弹窗/悬浮层全部消费同一 token
 * - rgb 三元组字段（accentRgb 等）供组件动态拼 rgba 透明度
 */
export interface DcScheme {
  key: string;
  label: string;
  dark: boolean;
  /** 页面外层背景 */
  bg: string;
  /** 页面氛围光（radial-gradient backgroundImage） */
  glow: string;
  /** 网格线颜色（含透明度） */
  grid: string;
  /** 主面板渐变与描边 */
  panelGradient: string;
  panelBorder: string;
  panelShadow: string;
  /** 悬浮层卡片（指标卡/侧栏） */
  surface: string;
  surfaceBorder: string;
  /** 文字 */
  text: string;
  muted: string;
  /** 语义色 */
  accent: string;
  accentRgb: string;
  ok: string;
  okRgb: string;
  warn: string;
  warnRgb: string;
  danger: string;
  dangerRgb: string;
  /** 顶栏/底栏渐变 */
  topBarGradient: string;
  bottomBarGradient: string;
  inputBg: string;
  barTrack: string;
  /** 2D 平面视图 */
  rowBg: string;
  rowBorder: string;
  cardBg: string;
  cardBgActive: string;
  cardBorder: string;
  cardBorderActive: string;
  cardWarnBorder: string;
  cardGlow: string;
  wellBg: string;
  wellBorder: string;
  texture: string;
  capFill: string;
  capWarnFill: string;
  /** 机柜正视图弹窗 */
  modalBg: string;
  modalBorder: string;
  modalTextMuted: string;
  freeSegBg: string;
  /** 浅色方案下设备类型文字用深色后缀（tailwind -800），深色方案用 -100 */
  deviceTextSuffix: string;
  /** 3D 场景（three.js 数字色值） */
  scene3d: { bg: number; grid1: number; grid2: number; floor: number; ambient: number };
}

export const COLOR_SCHEMES: DcScheme[] = [
  {
    key: 'deepsea',
    label: '深海蓝',
    dark: true,
    bg: '#0a1520',
    glow:
      'radial-gradient(ellipse at 20% 50%, rgba(0,80,150,0.08) 0%, transparent 60%), radial-gradient(ellipse at 80% 30%, rgba(123,97,255,0.05) 0%, transparent 60%)',
    grid: 'rgba(0,245,255,0.015)',
    panelGradient: 'linear-gradient(135deg, #142030 0%, #1a2a3a 50%, #142030 100%)',
    panelBorder: 'rgba(0,245,255,0.15)',
    panelShadow: '0 4px 20px rgba(0,0,0,0.5), inset 0 0 30px rgba(0,212,255,0.03)',
    surface: 'rgba(10,18,38,0.88)',
    surfaceBorder: 'rgba(0,245,255,0.15)',
    text: '#e8f6ff',
    muted: '#5a7a94',
    accent: '#00f5ff',
    accentRgb: '0,245,255',
    ok: '#00ff88',
    okRgb: '0,255,136',
    warn: '#ffaa00',
    warnRgb: '255,170,0',
    danger: '#ff3366',
    dangerRgb: '255,51,102',
    topBarGradient: 'linear-gradient(to bottom, rgba(12,24,50,0.9), rgba(8,16,32,0.7))',
    bottomBarGradient: 'linear-gradient(to top, rgba(8,16,32,0.9), rgba(6,12,24,0.85))',
    inputBg: 'rgba(0,0,0,0.3)',
    barTrack: 'rgba(255,255,255,0.06)',
    rowBg: 'rgba(10,18,38,0.7)',
    rowBorder: 'rgba(0,245,255,0.12)',
    cardBg: 'linear-gradient(180deg, rgba(10,24,40,0.75), rgba(8,16,30,0.85))',
    cardBgActive: 'linear-gradient(180deg, rgba(0,60,90,0.55), rgba(10,20,40,0.85))',
    cardBorder: 'rgba(0,245,255,0.22)',
    cardBorderActive: 'rgba(0,245,255,0.8)',
    cardWarnBorder: 'rgba(255,100,60,0.7)',
    cardGlow: '0 0 16px rgba(0,245,255,0.25)',
    wellBg: 'rgba(0,0,0,0.35)',
    wellBorder: 'rgba(0,245,255,0.12)',
    texture: 'repeating-linear-gradient(to top, rgba(0,245,255,0.06) 0 1px, transparent 1px 7px)',
    capFill: 'linear-gradient(to top, rgba(0,150,200,0.55), rgba(0,245,255,0.15))',
    capWarnFill: 'linear-gradient(to top, rgba(255,120,60,0.55), rgba(255,170,80,0.2))',
    modalBg: 'rgba(10,20,32,0.95)',
    modalBorder: 'rgba(0,245,255,0.2)',
    modalTextMuted: '#64748b',
    freeSegBg: 'rgba(255,255,255,0.03)',
    deviceTextSuffix: '100',
    scene3d: { bg: 0x1e2e3e, grid1: 0x4488aa, grid2: 0x335577, floor: 0x6a7a8a, ambient: 1.1 },
  },
  {
    key: 'graphite',
    label: '石墨灰',
    dark: true,
    bg: '#17191d',
    glow:
      'radial-gradient(ellipse at 20% 50%, rgba(45,212,191,0.05) 0%, transparent 60%), radial-gradient(ellipse at 80% 30%, rgba(163,230,53,0.03) 0%, transparent 60%)',
    grid: 'rgba(160,170,185,0.03)',
    panelGradient: 'linear-gradient(135deg, #1d2026 0%, #23262e 50%, #1d2026 100%)',
    panelBorder: 'rgba(160,170,185,0.22)',
    panelShadow: '0 4px 20px rgba(0,0,0,0.45), inset 0 0 30px rgba(45,212,191,0.02)',
    surface: 'rgba(29,32,38,0.92)',
    surfaceBorder: 'rgba(160,170,185,0.2)',
    text: '#e7eaee',
    muted: '#8b929c',
    accent: '#2dd4bf',
    accentRgb: '45,212,191',
    ok: '#a3e635',
    okRgb: '163,230,53',
    warn: '#fb923c',
    warnRgb: '251,146,60',
    danger: '#f87171',
    dangerRgb: '248,113,113',
    topBarGradient: 'linear-gradient(to bottom, rgba(29,32,38,0.94), rgba(23,25,29,0.82))',
    bottomBarGradient: 'linear-gradient(to top, rgba(29,32,38,0.94), rgba(20,22,26,0.88))',
    inputBg: 'rgba(0,0,0,0.35)',
    barTrack: 'rgba(255,255,255,0.08)',
    rowBg: 'rgba(29,32,38,0.8)',
    rowBorder: 'rgba(160,170,185,0.18)',
    cardBg: 'linear-gradient(180deg, rgba(40,44,52,0.85), rgba(28,31,38,0.9))',
    cardBgActive: 'linear-gradient(180deg, rgba(45,90,85,0.5), rgba(30,34,40,0.9))',
    cardBorder: 'rgba(160,170,185,0.28)',
    cardBorderActive: 'rgba(45,212,191,0.85)',
    cardWarnBorder: 'rgba(251,146,60,0.75)',
    cardGlow: '0 0 16px rgba(45,212,191,0.25)',
    wellBg: 'rgba(0,0,0,0.45)',
    wellBorder: 'rgba(160,170,185,0.15)',
    texture: 'repeating-linear-gradient(to top, rgba(45,212,191,0.07) 0 1px, transparent 1px 7px)',
    capFill: 'linear-gradient(to top, rgba(45,180,160,0.55), rgba(45,212,191,0.15))',
    capWarnFill: 'linear-gradient(to top, rgba(251,146,60,0.55), rgba(251,146,60,0.2))',
    modalBg: 'rgba(26,29,34,0.96)',
    modalBorder: 'rgba(160,170,185,0.25)',
    modalTextMuted: '#9ca3af',
    freeSegBg: 'rgba(255,255,255,0.04)',
    deviceTextSuffix: '100',
    scene3d: { bg: 0x23262c, grid1: 0x556066, grid2: 0x3d454c, floor: 0x555c64, ambient: 1.15 },
  },
  {
    key: 'terminal',
    label: '终端绿',
    dark: true,
    bg: '#060907',
    glow:
      'radial-gradient(ellipse at 20% 50%, rgba(0,255,157,0.06) 0%, transparent 60%), radial-gradient(ellipse at 80% 30%, rgba(0,255,157,0.04) 0%, transparent 60%)',
    grid: 'rgba(0,255,157,0.03)',
    panelGradient: 'linear-gradient(135deg, #0a120d 0%, #0e1811 50%, #0a120d 100%)',
    panelBorder: 'rgba(0,255,157,0.18)',
    panelShadow: '0 4px 20px rgba(0,0,0,0.6), inset 0 0 30px rgba(0,255,157,0.02)',
    surface: 'rgba(10,18,13,0.9)',
    surfaceBorder: 'rgba(0,255,157,0.16)',
    text: '#c9f2df',
    muted: '#5f7a6d',
    accent: '#00ff9d',
    accentRgb: '0,255,157',
    ok: '#00ff9d',
    okRgb: '0,255,157',
    warn: '#ffcc00',
    warnRgb: '255,204,0',
    danger: '#ff5555',
    dangerRgb: '255,85,85',
    topBarGradient: 'linear-gradient(to bottom, rgba(10,18,13,0.94), rgba(6,10,8,0.82))',
    bottomBarGradient: 'linear-gradient(to top, rgba(10,18,13,0.94), rgba(5,8,6,0.88))',
    inputBg: 'rgba(0,0,0,0.4)',
    barTrack: 'rgba(0,255,157,0.08)',
    rowBg: 'rgba(10,18,13,0.8)',
    rowBorder: 'rgba(0,255,157,0.14)',
    cardBg: 'linear-gradient(180deg, rgba(16,28,20,0.85), rgba(8,14,10,0.9))',
    cardBgActive: 'linear-gradient(180deg, rgba(0,80,50,0.5), rgba(10,18,13,0.9))',
    cardBorder: 'rgba(0,255,157,0.25)',
    cardBorderActive: 'rgba(0,255,157,0.85)',
    cardWarnBorder: 'rgba(255,204,0,0.7)',
    cardGlow: '0 0 16px rgba(0,255,157,0.25)',
    wellBg: 'rgba(0,0,0,0.5)',
    wellBorder: 'rgba(0,255,157,0.12)',
    texture: 'repeating-linear-gradient(to top, rgba(0,255,157,0.07) 0 1px, transparent 1px 7px)',
    capFill: 'linear-gradient(to top, rgba(0,200,125,0.55), rgba(0,255,157,0.15))',
    capWarnFill: 'linear-gradient(to top, rgba(255,204,0,0.5), rgba(255,204,0,0.18))',
    modalBg: 'rgba(8,14,10,0.96)',
    modalBorder: 'rgba(0,255,157,0.22)',
    modalTextMuted: '#5f7a6d',
    freeSegBg: 'rgba(0,255,157,0.04)',
    deviceTextSuffix: '100',
    scene3d: { bg: 0x0c1410, grid1: 0x1f7a55, grid2: 0x14523a, floor: 0x1a2620, ambient: 1.05 },
  },
  {
    key: 'paper',
    label: '素白',
    dark: false,
    bg: '#eef1f4',
    glow:
      'radial-gradient(ellipse at 20% 50%, rgba(14,116,144,0.07) 0%, transparent 60%), radial-gradient(ellipse at 80% 30%, rgba(100,116,139,0.05) 0%, transparent 60%)',
    grid: 'rgba(30,60,80,0.04)',
    panelGradient: 'linear-gradient(135deg, #f8fafc 0%, #f1f5f9 50%, #f8fafc 100%)',
    panelBorder: 'rgba(100,116,139,0.35)',
    panelShadow: '0 4px 20px rgba(15,23,42,0.1)',
    surface: 'rgba(255,255,255,0.92)',
    surfaceBorder: 'rgba(100,116,139,0.3)',
    text: '#1e293b',
    muted: '#64748b',
    accent: '#0e7490',
    accentRgb: '14,116,144',
    ok: '#15803d',
    okRgb: '21,128,61',
    warn: '#b45309',
    warnRgb: '180,83,9',
    danger: '#dc2626',
    dangerRgb: '220,38,38',
    topBarGradient: 'linear-gradient(to bottom, rgba(248,250,252,0.95), rgba(241,245,249,0.88))',
    bottomBarGradient: 'linear-gradient(to top, rgba(248,250,252,0.95), rgba(241,245,249,0.9))',
    inputBg: 'rgba(255,255,255,0.85)',
    barTrack: 'rgba(15,23,42,0.08)',
    rowBg: 'rgba(255,255,255,0.85)',
    rowBorder: 'rgba(100,116,139,0.3)',
    cardBg: 'linear-gradient(180deg, #ffffff, #f1f5f9)',
    cardBgActive: 'linear-gradient(180deg, #e6f4f7, #f0f9ff)',
    cardBorder: 'rgba(100,116,139,0.4)',
    cardBorderActive: 'rgba(14,116,144,0.8)',
    cardWarnBorder: 'rgba(220,38,38,0.6)',
    cardGlow: '0 4px 14px rgba(14,116,144,0.18)',
    wellBg: 'rgba(241,245,249,0.9)',
    wellBorder: 'rgba(100,116,139,0.35)',
    texture: 'repeating-linear-gradient(to top, rgba(14,116,144,0.08) 0 1px, transparent 1px 7px)',
    capFill: 'linear-gradient(to top, rgba(14,116,144,0.6), rgba(14,116,144,0.25))',
    capWarnFill: 'linear-gradient(to top, rgba(217,119,6,0.55), rgba(217,119,6,0.2))',
    modalBg: 'rgba(248,250,252,0.97)',
    modalBorder: 'rgba(100,116,139,0.4)',
    modalTextMuted: '#64748b',
    freeSegBg: 'rgba(15,23,42,0.04)',
    deviceTextSuffix: '800',
    scene3d: { bg: 0xdfe6ec, grid1: 0x9fb3c2, grid2: 0x7e93a3, floor: 0xb9c4cd, ambient: 1.6 },
  },
];

const LS_KEY_SCHEME = 'dc:color-scheme';

export function readColorSchemeKey(): string {
  try {
    const k = window.localStorage.getItem(LS_KEY_SCHEME);
    if (k && COLOR_SCHEMES.some(s => s.key === k)) return k;
  } catch {
    /* localStorage 不可用时用默认 */
  }
  return COLOR_SCHEMES[0].key;
}

export function writeColorSchemeKey(key: string): void {
  try {
    window.localStorage.setItem(LS_KEY_SCHEME, key);
  } catch {
    /* 忽略 */
  }
}

export function getSchemeByKey(key: string): DcScheme {
  return COLOR_SCHEMES.find(s => s.key === key) ?? COLOR_SCHEMES[0];
}

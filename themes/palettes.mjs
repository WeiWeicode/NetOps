// E-Learning 配色色票（scripts/make-themes.mjs 依這裡產生 src/themes/*.css）
// ★ 選用哪一套、微調顏色：改同資料夾的 theme.json，或開 http://localhost:5203/__themes 在預覽頁調整後按「套用」
// 要新增一套配色：在 THEMES 加一組 light / dark 色票（欄位同下）
//   bg 背景漸層（上→下）、halo 背景光暈、glass 卡片底、glassStrong 浮層底、glow 邊框基底、ink 標題文字、textRegular 內文、
//   mute 次要文字、dim 淡文字、placeholder 提示文字、field 輸入框底、overlay 遮罩、overlaySolid 下拉選單底、
//   danger / warn / run / done 狀態色、brand50~700 品牌色階、primary 主要按鈕、primaryText 主要按鈕文字

export const THEMES = {
  'solar-navy': {
    title: 'B｜太陽能深藍 × 陽光橙（預設暗色，SolarMES 使用中）',
    default: 'dark',
    light: {
      bg: ['#f3f6fa', '#e9eef5'], halo: ['rgba(255, 138, 31, 0.10)', 'rgba(56, 120, 200, 0.08)'],
      glass: 'rgba(255, 255, 255, 0.9)', glassStrong: 'rgba(255, 255, 255, 0.97)', glow: 'rgba(16, 42, 67, 0.14)',
      ink: '#0b1b2e', mute: '#4a5d73', dim: '#7a8ba0', field: '#ffffff', overlay: 'rgba(11, 27, 46, 0.4)',
      danger: '#c62828', warn: '#a14a05', run: '#137a3a', done: '#526072',
      brand50: 'rgba(224, 112, 10, 0.08)', brand100: '#ffe8d1', brand500: '#f07a12', brand600: '#b85300', brand700: '#8f4000',
      primary: '#f07a12', primaryText: '#0b1b2e', overlaySolid: '#ffffff', textRegular: '#1f3148', placeholder: '#8a9aae',
    },
    dark: {
      bg: ['#0b1b2e', '#0e2238'], halo: ['rgba(255, 138, 31, 0.10)', 'rgba(56, 140, 230, 0.10)'],
      glass: 'rgba(17, 38, 61, 0.82)', glassStrong: 'rgba(11, 27, 46, 0.96)', glow: 'rgba(120, 160, 210, 0.24)',
      ink: '#f2f6fa', mute: '#a3b6ca', dim: '#6f86a0', field: 'rgba(8, 22, 38, 0.7)', overlay: 'rgba(3, 10, 20, 0.7)',
      danger: '#f87171', warn: '#fbbf24', run: '#34d399', done: '#94a3b8',
      brand50: 'rgba(255, 138, 31, 0.12)', brand100: '#ffe3c7', brand500: '#ff8a1f', brand600: '#ffa451', brand700: '#e0700a',
      primary: '#ff8a1f', primaryText: '#0b1b2e', overlaySolid: '#11263d', textRegular: '#d5e0eb', placeholder: '#6f86a0',
    },
  },
  'steel-amber': {
    title: 'A｜鋼鐵灰 × 安全黃（預設暗色，工業現場風）',
    default: 'dark',
    light: {
      bg: ['#f1f3f5', '#e7eaee'], halo: ['rgba(245, 184, 0, 0.08)', 'rgba(100, 116, 139, 0.08)'],
      glass: 'rgba(255, 255, 255, 0.9)', glassStrong: 'rgba(255, 255, 255, 0.97)', glow: 'rgba(20, 24, 29, 0.14)',
      ink: '#14181d', mute: '#4b5563', dim: '#7b8490', field: '#ffffff', overlay: 'rgba(20, 24, 29, 0.4)',
      danger: '#c62828', warn: '#8a5a04', run: '#137a3a', done: '#555d69',
      brand50: 'rgba(180, 130, 0, 0.10)', brand100: '#fff3c4', brand500: '#e0a800', brand600: '#8a6500', brand700: '#6b4e00',
      primary: '#f5b800', primaryText: '#14181d', overlaySolid: '#ffffff', textRegular: '#262d36', placeholder: '#8b949e',
    },
    dark: {
      bg: ['#14181d', '#181d23'], halo: ['rgba(245, 184, 0, 0.06)', 'rgba(148, 163, 184, 0.05)'],
      glass: 'rgba(28, 34, 41, 0.9)', glassStrong: 'rgba(20, 24, 29, 0.97)', glow: 'rgba(154, 167, 180, 0.22)',
      ink: '#e8edf2', mute: '#9aa7b4', dim: '#6b7784', field: 'rgba(16, 20, 24, 0.7)', overlay: 'rgba(0, 0, 0, 0.65)',
      danger: '#ff6b6b', warn: '#f5b800', run: '#3dd68c', done: '#8a96a3',
      brand50: 'rgba(245, 184, 0, 0.12)', brand100: '#fff0bf', brand500: '#f5b800', brand600: '#ffc933', brand700: '#c79500',
      primary: '#f5b800', primaryText: '#14181d', overlaySolid: '#1c2229', textRegular: '#d3dae2', placeholder: '#6b7784',
    },
  },
  cleanroom: {
    title: 'C｜潔淨室白 × 工程藍（預設明亮，亮燈廠區好讀）',
    default: 'light',
    light: {
      bg: ['#eef2f6', '#e8edf3'], halo: ['rgba(11, 99, 206, 0.05)', 'rgba(11, 99, 206, 0.04)'],
      glass: 'rgba(255, 255, 255, 0.96)', glassStrong: 'rgba(255, 255, 255, 0.99)', glow: 'rgba(15, 27, 42, 0.13)',
      ink: '#0f1b2a', mute: '#52606f', dim: '#7d8a99', field: '#ffffff', overlay: 'rgba(15, 27, 42, 0.4)',
      danger: '#c62828', warn: '#a14a05', run: '#137a3a', done: '#526072',
      brand50: 'rgba(11, 99, 206, 0.07)', brand100: '#dcebfb', brand500: '#0b63ce', brand600: '#0a58b8', brand700: '#084a9a',
      primary: '#0b63ce', primaryText: '#ffffff', overlaySolid: '#ffffff', textRegular: '#243447', placeholder: '#8a96a4',
    },
    dark: {
      bg: ['#0f1720', '#121c27'], halo: ['rgba(96, 165, 250, 0.06)', 'rgba(96, 165, 250, 0.04)'],
      glass: 'rgba(22, 32, 44, 0.9)', glassStrong: 'rgba(15, 23, 32, 0.97)', glow: 'rgba(148, 170, 195, 0.2)',
      ink: '#eef3f8', mute: '#a5b4c4', dim: '#6e7e90', field: 'rgba(10, 16, 24, 0.7)', overlay: 'rgba(0, 6, 14, 0.7)',
      danger: '#f87171', warn: '#fbbf24', run: '#4ade80', done: '#94a3b8',
      brand50: 'rgba(96, 165, 250, 0.12)', brand100: '#dbeafe', brand500: '#60a5fa', brand600: '#93c5fd', brand700: '#3b82f6',
      primary: '#60a5fa', primaryText: '#0f1720', overlaySolid: '#16202c', textRegular: '#d6e0ea', placeholder: '#6e7e90',
    },
  },
  'scada-teal': {
    title: 'D｜控制室青綠（預設暗色，SCADA 監控風）',
    default: 'dark',
    light: {
      bg: ['#eef5f3', '#e6efed'], halo: ['rgba(20, 163, 131, 0.07)', 'rgba(20, 120, 160, 0.05)'],
      glass: 'rgba(255, 255, 255, 0.9)', glassStrong: 'rgba(255, 255, 255, 0.97)', glow: 'rgba(15, 110, 90, 0.18)',
      ink: '#0a1f1b', mute: '#3f5f58', dim: '#72908a', field: '#ffffff', overlay: 'rgba(10, 31, 27, 0.4)',
      danger: '#c62828', warn: '#8a5a04', run: '#0f7a62', done: '#526072',
      brand50: 'rgba(15, 122, 98, 0.08)', brand100: '#d3f3ea', brand500: '#14a383', brand600: '#0f7a62', brand700: '#0b5e4b',
      primary: '#0f7a62', primaryText: '#ffffff', overlaySolid: '#ffffff', textRegular: '#1c3631', placeholder: '#80a09a',
    },
    dark: {
      bg: ['#0a1614', '#0c1b19'], halo: ['rgba(43, 217, 176, 0.07)', 'rgba(43, 180, 217, 0.05)'],
      glass: 'rgba(15, 32, 29, 0.88)', glassStrong: 'rgba(10, 22, 20, 0.97)', glow: 'rgba(43, 217, 176, 0.22)',
      ink: '#e6f4f1', mute: '#93b8b0', dim: '#5f837b', field: 'rgba(6, 16, 14, 0.7)', overlay: 'rgba(0, 8, 6, 0.7)',
      danger: '#ff6b6b', warn: '#f2c94c', run: '#2bd9b0', done: '#7f9a94',
      brand50: 'rgba(43, 217, 176, 0.10)', brand100: '#c9f7ea', brand500: '#2bd9b0', brand600: '#5fe6c6', brand700: '#1fb894',
      primary: '#2bd9b0', primaryText: '#06120f', overlaySolid: '#0f201d', textRegular: '#cfe6e1', placeholder: '#5f837b',
    },
  },

  /* ───── SolarDMA：業務 / 生管 / MRP，辦公室螢幕長時間看報表 ───── */
  'dma-indigo': {
    title: 'E｜企業靛藍 × 銀灰（預設明亮，DMA 報表 / 排程）',
    default: 'light',
    light: {
      bg: ['#f2f4f9', '#eaedf5'], halo: ['rgba(67, 56, 202, 0.07)', 'rgba(100, 116, 139, 0.06)'],
      glass: 'rgba(255, 255, 255, 0.92)', glassStrong: 'rgba(255, 255, 255, 0.98)', glow: 'rgba(30, 27, 75, 0.13)',
      ink: '#161a33', mute: '#4f5673', dim: '#7e84a0', field: '#ffffff', overlay: 'rgba(22, 26, 51, 0.4)',
      danger: '#c62828', warn: '#a14a05', run: '#137a3a', done: '#565d73',
      brand50: 'rgba(67, 56, 202, 0.07)', brand100: '#e0e7ff', brand500: '#4f46e5', brand600: '#4338ca', brand700: '#3730a3',
      primary: '#4338ca', primaryText: '#ffffff', overlaySolid: '#ffffff', textRegular: '#262b48', placeholder: '#8c92ad',
    },
    dark: {
      bg: ['#12142a', '#161933'], halo: ['rgba(129, 140, 248, 0.10)', 'rgba(148, 163, 184, 0.05)'],
      glass: 'rgba(28, 31, 60, 0.86)', glassStrong: 'rgba(18, 20, 42, 0.97)', glow: 'rgba(165, 170, 230, 0.22)',
      ink: '#eef0fb', mute: '#a9aed0', dim: '#727899', field: 'rgba(10, 12, 28, 0.7)', overlay: 'rgba(4, 5, 16, 0.7)',
      danger: '#f87171', warn: '#fbbf24', run: '#4ade80', done: '#9ca3bb',
      brand50: 'rgba(129, 140, 248, 0.12)', brand100: '#e0e7ff', brand500: '#818cf8', brand600: '#a5b4fc', brand700: '#6366f1',
      primary: '#818cf8', primaryText: '#12142a', overlaySolid: '#1c1f3c', textRegular: '#d6d9f0', placeholder: '#727899',
    },
  },
  'ledger-green': {
    title: 'F｜帳冊綠（預設明亮，像 Excel，業務 / 生管上手快）',
    default: 'light',
    light: {
      bg: ['#f3f6f4', '#eaefec'], halo: ['rgba(29, 111, 66, 0.06)', 'rgba(71, 85, 105, 0.05)'],
      glass: 'rgba(255, 255, 255, 0.95)', glassStrong: 'rgba(255, 255, 255, 0.99)', glow: 'rgba(20, 50, 35, 0.14)',
      ink: '#132019', mute: '#4a5a51', dim: '#7b8a82', field: '#ffffff', overlay: 'rgba(19, 32, 25, 0.4)',
      danger: '#c62828', warn: '#a14a05', run: '#1d6f42', done: '#555f69',
      brand50: 'rgba(29, 111, 66, 0.07)', brand100: '#d7f0e1', brand500: '#21a366', brand600: '#1d6f42', brand700: '#155232',
      primary: '#1d6f42', primaryText: '#ffffff', overlaySolid: '#ffffff', textRegular: '#22332a', placeholder: '#8a9890',
    },
    dark: {
      bg: ['#111815', '#141c18'], halo: ['rgba(82, 201, 138, 0.07)', 'rgba(148, 163, 184, 0.04)'],
      glass: 'rgba(24, 34, 29, 0.9)', glassStrong: 'rgba(17, 24, 21, 0.97)', glow: 'rgba(150, 190, 168, 0.2)',
      ink: '#ebf3ee', mute: '#a2b8ab', dim: '#6d8276', field: 'rgba(8, 14, 11, 0.7)', overlay: 'rgba(0, 6, 3, 0.7)',
      danger: '#f87171', warn: '#fbbf24', run: '#52c98a', done: '#94a3b8',
      brand50: 'rgba(82, 201, 138, 0.11)', brand100: '#d7f0e1', brand500: '#52c98a', brand600: '#7ddaa6', brand700: '#33a86b',
      primary: '#52c98a', primaryText: '#0c1511', overlaySolid: '#18221d', textRegular: '#d2e2d8', placeholder: '#6d8276',
    },
  },
  'sunrise-gold': {
    title: 'G｜暖白 × 琥珀金（預設明亮，太陽能品牌感、柔和不刺眼）',
    default: 'light',
    light: {
      bg: ['#f8f5ef', '#f1ece3'], halo: ['rgba(217, 119, 6, 0.09)', 'rgba(180, 83, 9, 0.05)'],
      glass: 'rgba(255, 253, 249, 0.9)', glassStrong: 'rgba(255, 253, 249, 0.98)', glow: 'rgba(68, 44, 14, 0.14)',
      ink: '#241a0e', mute: '#5b4c3a', dim: '#8a7a66', field: '#fffdf9', overlay: 'rgba(36, 26, 14, 0.4)',
      danger: '#c62828', warn: '#9a3412', run: '#137a3a', done: '#5d5850',
      brand50: 'rgba(217, 119, 6, 0.09)', brand100: '#fdecc8', brand500: '#d97706', brand600: '#a35205', brand700: '#7c3d04',
      primary: '#e08a0b', primaryText: '#241a0e', overlaySolid: '#fffdf9', textRegular: '#3a2c1b', placeholder: '#978873',
    },
    dark: {
      bg: ['#1a1611', '#1f1a14'], halo: ['rgba(245, 158, 11, 0.09)', 'rgba(217, 119, 6, 0.05)'],
      glass: 'rgba(36, 30, 23, 0.88)', glassStrong: 'rgba(26, 22, 17, 0.97)', glow: 'rgba(214, 186, 140, 0.2)',
      ink: '#f7f1e8', mute: '#c2b39f', dim: '#8a7c6a', field: 'rgba(14, 11, 8, 0.7)', overlay: 'rgba(8, 5, 2, 0.7)',
      danger: '#f87171', warn: '#fb923c', run: '#4ade80', done: '#a8a29e',
      brand50: 'rgba(245, 158, 11, 0.12)', brand100: '#fdecc8', brand500: '#f59e0b', brand600: '#fbbf24', brand700: '#d97706',
      primary: '#f59e0b', primaryText: '#1a1611', overlaySolid: '#241e17', textRegular: '#e3d9cb', placeholder: '#8a7c6a',
    },
  },
  'plum-night': {
    title: 'H｜深夜紫 × 洋紅點綴（預設暗色，儀表板 / 夜間）',
    default: 'dark',
    light: {
      bg: ['#f6f3fa', '#eeeaf5'], halo: ['rgba(126, 34, 206, 0.07)', 'rgba(219, 39, 119, 0.05)'],
      glass: 'rgba(255, 255, 255, 0.9)', glassStrong: 'rgba(255, 255, 255, 0.98)', glow: 'rgba(46, 16, 101, 0.13)',
      ink: '#1e1330', mute: '#58496e', dim: '#877a99', field: '#ffffff', overlay: 'rgba(30, 19, 48, 0.4)',
      danger: '#c62828', warn: '#a14a05', run: '#137a3a', done: '#5c5869',
      brand50: 'rgba(126, 34, 206, 0.07)', brand100: '#f3e8ff', brand500: '#a855f7', brand600: '#7e22ce', brand700: '#6b21a8',
      primary: '#7e22ce', primaryText: '#ffffff', overlaySolid: '#ffffff', textRegular: '#2e2142', placeholder: '#948aa5',
    },
    dark: {
      bg: ['#140f1f', '#181226'], halo: ['rgba(192, 132, 252, 0.11)', 'rgba(244, 114, 182, 0.07)'],
      glass: 'rgba(33, 25, 50, 0.84)', glassStrong: 'rgba(20, 15, 31, 0.97)', glow: 'rgba(196, 170, 235, 0.22)',
      ink: '#f4effb', mute: '#b5a8cc', dim: '#7c6f94', field: 'rgba(10, 7, 18, 0.7)', overlay: 'rgba(5, 2, 12, 0.7)',
      danger: '#fb7185', warn: '#fbbf24', run: '#4ade80', done: '#a49fb3',
      brand50: 'rgba(192, 132, 252, 0.12)', brand100: '#f3e8ff', brand500: '#f472b6', brand600: '#d8b4fe', brand700: '#a855f7',
      primary: '#c084fc', primaryText: '#140f1f', overlaySolid: '#211932', textRegular: '#ddd3ec', placeholder: '#7c6f94',
    },
  },
}

/* E-Learning 使用中（沿用 SolarDMA）：明亮用 E 企業靛藍、暗色用 H 深夜紫（兩組色票直接沿用，改色請改上面 E / H 或 theme.json 的 custom） */
THEMES['solar-dma'] = {
  title: 'SolarDMA｜明亮 E 企業靛藍 × 暗色 H 深夜紫（預設明亮，E-Learning 使用中）',
  default: 'light',
  light: THEMES['dma-indigo'].light,
  dark: THEMES['plum-night'].dark,
}


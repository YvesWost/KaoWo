/* KaoWo 主题配色（高度自定义版 + 服务端持久化）
 *
 * 用户可在调色盘里分别给「轮廓(主题色) / 背景 / 字体」指定不同颜色：
 *  - 轮廓 accent：--blue 主色系（选中框、按钮、得分环、当前题…）与边框线 --line*。
 *  - 背景 bg：--bg / --surface / --surface-2/3 / --hover-bg，主题色按 strength 大量染上去。
 *  - 字体 text：--ink / --ink-2 / --ink-3。
 * 「默认浅色 / 默认深色」两个按钮是原明暗切换，收进面板，点击即切基底并清除全部自定义。
 *
 * 持久化（跨浏览器 / 多端口 / 不同访问地址共享）：
 *  - 权威源是服务端 data/theme-user.json，经相对路径 /api/theme 读写；无论用 127.0.0.1、
 *    localhost 还是局域网 IP、无论哪个端口，都打到同一份文件。
 *  - 启动即 GET 覆盖本地；每次改动防抖 POST 推送；定时 + 切回页面时轮询，按 rev 跟随其他端。
 *  - localStorage 降级为「首帧防闪 + 服务端不可用时的离线缓存」，不再是权威源。
 *  - 出厂默认（预设色 / contrast / strength）仍来自 static/theme.json，与用户选择分离。
 *
 * 设计约束（勿破坏）：
 *  - 未启用任何自定义时，不写任何内联变量，CSS 保持 100% 原样（只是 data-theme 可能为 dark）。
 *  - 红 / 黄 / 绿 对错色及 --on-color / --on-amber 属功能色，一律不动。
 *  - 字体色未自定义时，若新背景让默认文字对比不足，自动按最小对比度取黑或白，保证可读。
 *  - 与作答缓存 exam:<sid>、题库、会话数据完全无关，不 fetch 任何考试接口。
 *  - 零外部依赖；服务端 / 默认配置读取失败时都用内置兜底，离线也能用。
 */
(function () {
  "use strict";

  // ---------------------------------------------------------------- 内置兜底配置
  var DEFAULTS = {
    defaultAccent: "#1a6fd4",
    contrast: 4.5,        // 文字 / 主色与背景的最小对比度（WCAG AA 正文 4.5:1）
    strength: 0.38,       // 主题色应用到背景的默认比例（越大背景越"有色"）
    presets: [
      "#1a6fd4", "#0891b2", "#0d9488", "#059669", "#65a30d", "#ca8a04",
      "#ea580c", "#dc2626", "#db2777", "#9333ea", "#4f46e5", "#475569"
    ]
  };

  // 明暗两套中性基准，与 style.css 的 :root / [data-theme="dark"] 一致，仅作计算基准。
  var NEUTRAL = {
    light: {
      surface: "#ffffff", bg: "#f1f3f6", surface2: "#f7f9fc", surface3: "#f2f4f7", hover: "#fafcff",
      ink: "#1f2329", ink2: "#4e5969", ink3: "#86909c",
      line: "#e3e6eb", lineStrong: "#c9d2dd", lineDot: "#c2c9d4", sep: "#d4d8de", ring: "#e9edf3"
    },
    dark: {
      surface: "#1d2530", bg: "#141922", surface2: "#232d3b", surface3: "#283342", hover: "#22303f",
      ink: "#e6e9ef", ink2: "#b3bcc9", ink3: "#8b95a5",
      line: "#2b3442", lineStrong: "#3c4757", lineDot: "#4a5568", sep: "#3a4454", ring: "#2b3442"
    }
  };

  // 由本模块接管的 CSS 变量（清除时逐个 removeProperty，回到默认样式）
  var MANAGED = [
    "--blue", "--blue-dark", "--blue-soft", "--blue-grad", "--blue-hover", "--blue-cell-border",
    "--blue-ring", "--lg-done-bg", "--lg-done-bd", "--lg-todo-bd",
    "--bg", "--surface", "--surface-2", "--surface-3", "--hover-bg",
    "--ink", "--ink-2", "--ink-3",
    "--line", "--line-strong", "--line-dot", "--sep", "--ring-track"
  ];

  var API = "/api/theme";          // 相对路径：任意 host / 端口都指向同一服务端文件
  var PUSH_DELAY = 350;            // 改动后防抖推送（ms）
  var POLL_MS = 3000;              // 轮询间隔（跟随其他浏览器 / 标签页的改动）

  var PALETTE_KEY = "exam-ui:palette";   // 首帧防闪 + 离线降级缓存，不再是权威源
  var THEME_KEY = "exam-ui:theme";       // 兼容 exam.html 头部防闪脚本与旧版
  var cfg = null;
  var state = null;
  var lastVars = null;   // 最近一次计算结果
  var eff = null;        // 实际生效色 { bg, surface, ink, blue, line }
  var open = false;
  var pop = null;

  var knownRev = 0;      // 已知的服务端版本
  var dirty = false;     // 本地有尚未推送的改动（此时本地优先，不被轮询覆盖）
  var pushTimer = null;

  // ---------------------------------------------------------------- 颜色工具
  function clamp(v, a, b) { return v < a ? a : (v > b ? b : v); }
  function hex2rgb(hex) {
    var s = String(hex == null ? "" : hex).trim().replace(/^#/, "");
    if (s.length === 3) s = s[0] + s[0] + s[1] + s[1] + s[2] + s[2];
    if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
    return [parseInt(s.slice(0, 2), 16), parseInt(s.slice(2, 4), 16), parseInt(s.slice(4, 6), 16)];
  }
  function isHex(h) { return !!hex2rgb(h); }
  function rgb2hex(c) {
    return "#" + c.map(function (v) {
      var h = Math.round(clamp(v, 0, 255)).toString(16);
      return h.length === 1 ? "0" + h : h;
    }).join("");
  }
  function toHex6(h) { var c = hex2rgb(h); return c ? rgb2hex(c) : "#1a6fd4"; }
  function rgb2hsl(c) {
    var r = c[0] / 255, g = c[1] / 255, b = c[2] / 255;
    var mx = Math.max(r, g, b), mn = Math.min(r, g, b), d = mx - mn;
    var h = 0, s = 0, l = (mx + mn) / 2;
    if (d !== 0) {
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }
  function hsl2rgb(h, s, l) {
    h = ((h % 360) + 360) % 360; s = clamp(s, 0, 1); l = clamp(l, 0, 1);
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var x = c * (1 - Math.abs(((h / 60) % 2) - 1));
    var m = l - c / 2, seg = Math.floor(h / 60) % 6, r, g, b;
    if (seg === 0) { r = c; g = x; b = 0; }
    else if (seg === 1) { r = x; g = c; b = 0; }
    else if (seg === 2) { r = 0; g = c; b = x; }
    else if (seg === 3) { r = 0; g = x; b = c; }
    else if (seg === 4) { r = x; g = 0; b = c; }
    else { r = c; g = 0; b = x; }
    return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
  }
  function lum(c) {
    function f(v) { v = v / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); }
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function contrast(a, b) {
    var la = lum(a), lb = lum(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }
  function mix(a, b, t) {
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  }
  // 保持色相/饱和度，只沿明度方向调整，直到与背景达到目标对比度
  function fitContrast(hsl, bg, C, base) {
    var dir = base === "dark" ? 1 : -1;
    var l = hsl.l;
    var rgb = hsl2rgb(hsl.h, hsl.s, l);
    var guard = 0;
    while (contrast(rgb, bg) < C && guard++ < 120) {
      var nl = clamp(l + dir * 0.012, 0.03, 0.97);
      if (nl === l) break;
      l = nl;
      rgb = hsl2rgb(hsl.h, hsl.s, l);
    }
    return { rgb: rgb, h: hsl.h, s: hsl.s, l: l };
  }
  // 与背景对比最高的黑 / 白（对任意背景二者较大值必 ≥ 4.58，保证达标）
  function bestText(bg) {
    return contrast([0, 0, 0], bg) >= contrast([255, 255, 255], bg) ? "#000000" : "#ffffff";
  }

  // ---------------------------------------------------------------- 由各槽位生成整套变量
  function compute() {
    var N = NEUTRAL[state.base];
    var C = cfg.contrast;
    var k = clamp(state.strength, 0, 1);
    var out = {};

    var accentRaw = state.accent ? hex2rgb(state.accent) : null;
    // 染色用的颜色：暗色基底把原色提亮，否则深色染不动
    var dye = null;
    if (accentRaw) {
      var hs = rgb2hsl(accentRaw);
      dye = state.base === "dark"
        ? hsl2rgb(hs.h, hs.s, clamp(hs.l + 0.30, 0.45, 0.82))
        : accentRaw;
    }

    // ---- 1. 背景（主题色大量应用 / 或用户单独指定） ----
    var surfaceRgb = hex2rgb(N.surface);
    var bgBigRgb = hex2rgb(N.bg);
    if (state.bg) {
      var b = hex2rgb(state.bg);
      bgBigRgb = b;
      surfaceRgb = mix(b, hex2rgb(N.surface), 0.35);
      out["--bg"] = rgb2hex(b);
      out["--surface"] = rgb2hex(surfaceRgb);
      out["--surface-2"] = rgb2hex(mix(b, hex2rgb(N.surface2), 0.22));
      out["--surface-3"] = rgb2hex(mix(b, hex2rgb(N.surface3), 0.30));
      out["--hover-bg"] = rgb2hex(mix(b, hex2rgb(N.hover), 0.45));
    } else if (dye) {
      bgBigRgb = mix(hex2rgb(N.bg), dye, k);
      surfaceRgb = mix(hex2rgb(N.surface), dye, k * 0.5);
      out["--bg"] = rgb2hex(bgBigRgb);
      out["--surface"] = rgb2hex(surfaceRgb);
      out["--surface-2"] = rgb2hex(mix(hex2rgb(N.surface2), dye, k * 0.55));
      out["--surface-3"] = rgb2hex(mix(hex2rgb(N.surface3), dye, k * 0.62));
      out["--hover-bg"] = rgb2hex(mix(hex2rgb(N.hover), dye, k * 0.62));
    }

    // ---- 2. 边框 / 轮廓线（以中性边框为基准；染色强度为 0 时完全回到默认边框） ----
    if (state.bg || dye) {
      var lineSrc = dye || hex2rgb(state.bg);
      out["--line"] = rgb2hex(mix(hex2rgb(N.line), lineSrc, k * 0.45));
      out["--line-strong"] = rgb2hex(mix(hex2rgb(N.lineStrong), lineSrc, k * 0.65));
      out["--line-dot"] = rgb2hex(mix(hex2rgb(N.lineDot), lineSrc, k * 0.55));
      out["--sep"] = rgb2hex(mix(hex2rgb(N.sep), lineSrc, k * 0.50));
      out["--ring-track"] = rgb2hex(mix(hex2rgb(N.ring), lineSrc, k * 0.40));
    }

    // ---- 3. 主色系（轮廓 / 选中框 / 按钮 / 得分环） ----
    var blueRgb = null;
    if (accentRaw) {
      var main = fitContrast(rgb2hsl(accentRaw), surfaceRgb, C, state.base);
      blueRgb = main.rgb;
      var dir = state.base === "dark" ? 1 : -1;
      var lDark = clamp(main.l + dir * 0.12, 0.02, 0.98);
      var blueDark = hsl2rgb(main.h, main.s, lDark);
      var soft = mix(surfaceRgb, blueRgb, state.base === "dark" ? 0.24 : 0.16);
      var g = 0;
      while (contrast(blueDark, soft) < C && g++ < 60) {
        lDark = clamp(lDark + dir * 0.02, 0.02, 0.98);
        blueDark = hsl2rgb(main.h, main.s, lDark);
      }
      var cellBd = mix(surfaceRgb, blueRgb, 0.45);
      out["--blue"] = rgb2hex(blueRgb);
      out["--blue-dark"] = rgb2hex(blueDark);
      out["--blue-soft"] = rgb2hex(soft);
      out["--blue-grad"] = rgb2hex(hsl2rgb(main.h, main.s, clamp(main.l + 0.16, 0, 1)));
      out["--blue-hover"] = rgb2hex(hsl2rgb(main.h, main.s, clamp(main.l + dir * 0.07, 0.02, 0.98)));
      out["--blue-cell-border"] = rgb2hex(cellBd);
      out["--blue-ring"] = "rgba(" + Math.round(blueRgb[0]) + "," + Math.round(blueRgb[1]) + "," +
        Math.round(blueRgb[2]) + "," + (state.base === "dark" ? 0.28 : 0.18) + ")";
      out["--lg-done-bg"] = rgb2hex(soft);
      out["--lg-done-bd"] = rgb2hex(cellBd);
      out["--lg-todo-bd"] = out["--line"] || N.line;
    }

    // ---- 4. 字体（可自定义；否则自动保证在新背景上可读） ----
    var inkRgb;
    if (state.text) {
      inkRgb = hex2rgb(state.text);
      out["--ink"] = rgb2hex(inkRgb);
      out["--ink-2"] = rgb2hex(mix(inkRgb, surfaceRgb, 0.28));
      out["--ink-3"] = rgb2hex(mix(inkRgb, surfaceRgb, 0.48));
    } else {
      var dInk = hex2rgb(N.ink);
      if ((state.bg || accentRaw) && contrast(dInk, surfaceRgb) < C) {
        inkRgb = hex2rgb(bestText(surfaceRgb));
        out["--ink"] = rgb2hex(inkRgb);
        out["--ink-2"] = rgb2hex(mix(inkRgb, surfaceRgb, 0.22));
        out["--ink-3"] = rgb2hex(mix(inkRgb, surfaceRgb, 0.42));
      } else {
        inkRgb = dInk;
      }
    }

    eff = {
      bg: out["--bg"] || N.bg,
      surface: rgb2hex(surfaceRgb),
      ink: rgb2hex(inkRgb),
      blue: blueRgb ? rgb2hex(blueRgb) : null,
      line: out["--line"] || N.line
    };
    out.__contrast = contrast(inkRgb, surfaceRgb);
    out.__ink = eff.ink;
    out.__surface = eff.surface;
    return out;
  }

  // ---------------------------------------------------------------- 应用 / 清除
  function clearVars() {
    var s = document.documentElement.style;
    MANAGED.forEach(function (k) { s.removeProperty(k); });
  }
  function applyVars(v) {
    clearVars();
    var s = document.documentElement.style;
    MANAGED.forEach(function (k) { if (v[k] != null) s.setProperty(k, v[k]); });
  }
  function active() { return !!(state.accent || state.bg || state.text); }

  function refresh() {
    if (!active()) { clearVars(); lastVars = null; eff = null; return; }
    var v = compute();
    lastVars = v;
    applyVars(v);
    if (open) { updateReadout(); syncInputs(); }
  }

  // 明暗基底（现在是 theme.js 唯一来源，app.js 不再碰 data-theme）
  function applyBase() {
    var b = state.base === "dark" ? "dark" : "light";
    if (document.documentElement.dataset.theme !== b) {
      document.documentElement.dataset.theme = b;
    }
    try { localStorage.setItem(THEME_KEY, b); } catch (e) {}
  }

  // ---------------------------------------------------------------- 配置 / 持久化
  function mergeDefaults(d) {
    var o = JSON.parse(JSON.stringify(DEFAULTS));
    if (!d || typeof d !== "object") return o;
    if (typeof d.contrast === "number") o.contrast = clamp(d.contrast, 3, 21);
    if (typeof d.strength === "number") o.strength = clamp(d.strength, 0, 1);
    if (isHex(d.defaultAccent)) o.defaultAccent = d.defaultAccent;
    if (Array.isArray(d.presets) && d.presets.length) {
      var p = d.presets.filter(isHex);
      if (p.length) o.presets = p;
    }
    return o;
  }
  // 规范化 state（补 base / strength 默认值、过滤非法值），localStorage 与服务端共用
  function normalizeState(raw) {
    var s = { base: null, accent: null, bg: null, text: null, strength: DEFAULTS.strength };
    if (raw && typeof raw === "object") {
      if (raw.base === "dark" || raw.base === "light") s.base = raw.base;
      if (isHex(raw.accent)) s.accent = toHex6(raw.accent);
      if (isHex(raw.bg)) s.bg = toHex6(raw.bg);
      if (isHex(raw.text)) s.text = toHex6(raw.text);
      if (typeof raw.strength === "number") s.strength = clamp(raw.strength, 0, 1);
    }
    if (!s.base) {
      var t = null;
      try { t = localStorage.getItem(THEME_KEY); } catch (e) {}
      s.base = (t === "dark" || t === "light") ? t
        : (document.documentElement.dataset.theme === "dark" ? "dark" : "light");
    }
    return s;
  }
  // state 指纹：键顺序固定，用于判断两端内容是否一致
  function stateKey(s) {
    return [s.base, s.accent || "", s.bg || "", s.text || "", Number(s.strength).toFixed(4)].join("|");
  }
  function load() {
    var raw = null;
    try { raw = JSON.parse(localStorage.getItem(PALETTE_KEY) || "null"); } catch (e) {}
    state = normalizeState(raw);   // 首帧防闪；随后 loadRemote 会用服务端值覆盖
  }
  function cacheLocal() {
    try { localStorage.setItem(PALETTE_KEY, JSON.stringify(state)); } catch (e) {}
    try { localStorage.setItem(THEME_KEY, state.base); } catch (e) {}
  }
  function persist() {
    cacheLocal();
    schedulePush();
  }
  function loadConfig() {
    try {
      fetch("/static/theme.json", { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || typeof d !== "object") return;
          cfg = mergeDefaults(d);
          refresh();
          if (open && document.body) renderPalette();
        })
        .catch(function () {});
    } catch (e) {}
  }

  // ---- 服务端权威源：启动拉取 / 改动推送 / 轮询跟随 ----
  function schedulePush() {
    dirty = true;
    if (pushTimer) clearTimeout(pushTimer);
    pushTimer = setTimeout(pushNow, PUSH_DELAY);
  }
  function pushNow() {
    pushTimer = null;
    var snap = stateKey(state);
    try {
      fetch(API, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        cache: "no-store",
        body: JSON.stringify({ state: state })
      }).then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || typeof d !== "object") return;
          if (typeof d.rev === "number") knownRev = Math.max(knownRev, d.rev);
          if (stateKey(state) === snap) dirty = false;   // 推送期间没再改 -> 已同步
          else schedulePush();                            // 期间又改了 -> 再推一次
        })
        .catch(function () {});
    } catch (e) {}
  }
  function applyRemote(remote) {
    state = normalizeState(remote);
    dirty = false;
    cacheLocal();
    applyBase();
    refresh();
    // 面板打开时只同步控件，不重建 DOM，避免打断正在拖动的取色器
    if (open && document.body) { syncInputs(); updateReadout(); }
  }
  function loadRemote() {
    try {
      fetch(API, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || typeof d !== "object") return;      // 服务端不可用 -> 保持 localStorage 降级
          if (typeof d.rev === "number") knownRev = d.rev;
          var hasServer = d.state && typeof d.state === "object" && Object.keys(d.state).length > 0;
          if (hasServer) {
            applyRemote(d.state);                       // 服务端为准（含「清除自定义」后的干净态）
          } else if (active()) {
            schedulePush();                             // 首次升级：把本地已有选择迁移上服务端
          } else {
            applyRemote(d.state);                       // 都干净，统一基底
          }
        })
        .catch(function () {});
    } catch (e) {}
  }
  function pollOnce() {
    try {
      fetch(API, { cache: "no-store" })
        .then(function (r) { return r.ok ? r.json() : null; })
        .then(function (d) {
          if (!d || typeof d !== "object" || typeof d.rev !== "number") return;
          if (d.rev === knownRev) return;               // 版本没变，无事
          var remote = normalizeState(d.state);
          var rk = stateKey(remote);
          if (dirty || pushTimer) return;               // 本地有未推送改动 -> 本地优先，下轮再看
          knownRev = d.rev;
          if (rk === stateKey(state)) return;           // 内容一致，只更新版本
          applyRemote(remote);                         // 本地干净且远端不同 -> 跟随其他端
        })
        .catch(function () {});
    } catch (e) {}
  }
  function startPolling() {
    setInterval(pollOnce, POLL_MS);
    document.addEventListener("visibilitychange", function () { if (!document.hidden) pollOnce(); });
    window.addEventListener("focus", pollOnce);
  }

  // ---------------------------------------------------------------- 状态变更
  // 「默认浅色 / 默认深色」= 切基底 + 清除全部自定义，回到该主题干净预设
  function setBase(b) {
    state.base = b === "dark" ? "dark" : "light";
    state.accent = state.bg = state.text = null;
    state.strength = cfg.strength;
    persist();
    applyBase();
    refresh();                       // 清自定义 -> clearVars
    if (open && document.body) renderPalette();
  }
  function setSlot(name, hex) {
    if (hex != null && !isHex(hex)) return;
    state[name] = hex == null ? null : toHex6(hex);
    persist();
    refresh();
    if (open) { updateReadout(); syncInputs(); }
  }
  function setStrength(v) {
    state.strength = clamp(v, 0, 1);
    persist();
    refresh();
    if (open) { updateReadout(); syncInputs(); }
  }
  function autoFixText() {
    var N = NEUTRAL[state.base];
    var surf = eff ? hex2rgb(eff.surface) : hex2rgb(N.surface);
    setSlot("text", bestText(surf));
  }
  function clearAll() {
    state.accent = state.bg = state.text = null;
    state.strength = cfg.strength;
    persist();
    refresh();
    if (open && document.body) renderPalette();
  }

  // ---------------------------------------------------------------- 调色盘 UI
  function ensurePop() {
    if (pop) return pop;
    pop = document.createElement("div");
    pop.id = "kw-palette";
    document.body.appendChild(pop);
    return pop;
  }
  function readoutInfo() {
    var N = NEUTRAL[state.base];
    var ink = lastVars ? lastVars.__ink : N.ink;
    var surf = lastVars ? lastVars.__surface : N.surface;
    var c = contrast(hex2rgb(ink), hex2rgb(surf));
    return { ink: ink, surface: surf, c: c, ok: c >= cfg.contrast };
  }
  function updateReadout() {
    var el = document.getElementById("kw-contrast");
    var info = readoutInfo();
    if (el) {
      el.className = "kw-contrast" + (info.ok ? " ok" : " bad");
      el.innerHTML = "字体 <b>" + info.ink + "</b> 与卡片 <b>" + info.surface + "</b> 对比 <b>" +
        info.c.toFixed(2) + ":1</b> · 目标 ≥ " + cfg.contrast + " " +
        (info.ok ? "✓ 达标" : "⚠ 不足，建议自动修正");
    }
    var sv = document.getElementById("kw-strength-val");
    if (sv) sv.textContent = Math.round(state.strength * 100) + "%";
  }
  // 不重建面板，只同步各输入控件与高亮（拖动取色器时不会中断）
  function syncInputs() {
    if (!open) return;
    var N = NEUTRAL[state.base];
    function set(id, v) {
      var e = document.getElementById(id);
      if (e && e !== document.activeElement && e.value !== v) e.value = v;
    }
    set("kw-accent", state.accent || cfg.defaultAccent);
    set("kw-accent-hex", state.accent || cfg.defaultAccent);
    set("kw-bg", state.bg || (eff ? eff.bg : N.bg));
    set("kw-bg-hex", state.bg || (eff ? eff.bg : N.bg));
    set("kw-text", state.text || (eff ? eff.ink : N.ink));
    set("kw-text-hex", state.text || (eff ? eff.ink : N.ink));
    set("kw-strength-val", Math.round(state.strength * 100) + "%");
    [].forEach.call(document.querySelectorAll(".kw-swatch"), function (b) {
      b.classList.toggle("on", !!state.accent &&
        b.getAttribute("data-swatch").toLowerCase() === state.accent.toLowerCase());
    });
    [].forEach.call(document.querySelectorAll(".kw-base"), function (b) {
      b.classList.toggle("on", b.getAttribute("data-base") === state.base);
    });
  }

  function renderPalette() {
    var el = ensurePop();
    var N = NEUTRAL[state.base];
    var sw = cfg.presets.map(function (p) {
      var on = state.accent && state.accent.toLowerCase() === p.toLowerCase();
      return '<button class="kw-swatch' + (on ? " on" : "") + '" data-swatch="' + p +
        '" style="background:' + p + '" title="' + p + '"></button>';
    }).join("");
    var info = readoutInfo();
    var accentVal = state.accent || cfg.defaultAccent;
    var bgVal = state.bg || (eff ? eff.bg : N.bg);
    var textVal = state.text || (eff ? eff.ink : N.ink);

    el.innerHTML =
      '<div class="kw-mask" data-palette-close></div>' +
      '<div class="kw-panel" role="dialog" aria-label="主题配色">' +
        '<div class="kw-head"><b>主题配色</b>' +
          '<button class="kw-x" data-palette-close aria-label="关闭">×</button></div>' +
        '<div class="kw-body">' +
          '<div class="kw-label">主题色 · 轮廓 / 选中框 / 按钮</div>' +
          '<div class="kw-swatches">' + sw + "</div>" +
          '<div class="kw-row kw-slot">' +
            '<input type="color" id="kw-accent" value="' + toHex6(accentVal) + '">' +
            '<input type="text" id="kw-accent-hex" value="' + accentVal + '" spellcheck="false" maxlength="7">' +
            '<button class="kw-mini" data-apply="accent">应用</button>' +
            '<button class="kw-mini kw-clear" data-clear="accent" title="清除，回到默认主色">↺</button>' +
          "</div>" +

          '<div class="kw-label">背景 · 主题色大量应用</div>' +
          '<div class="kw-row kw-strength">' +
            '<span>染色强度</span>' +
            '<input type="range" id="kw-strength" min="0" max="100" value="' + Math.round(state.strength * 100) + '">' +
            '<b id="kw-strength-val">' + Math.round(state.strength * 100) + "%</b>" +
          "</div>" +
          '<div class="kw-row kw-slot">' +
            '<span class="kw-slotlabel">单独指定</span>' +
            '<input type="color" id="kw-bg" value="' + toHex6(bgVal) + '">' +
            '<input type="text" id="kw-bg-hex" value="' + bgVal + '" spellcheck="false" maxlength="7">' +
            '<button class="kw-mini" data-apply="bg">应用</button>' +
            '<button class="kw-mini kw-clear" data-clear="bg" title="清除，回到跟随主题色">↺</button>' +
          "</div>" +

          '<div class="kw-label">字体色</div>' +
          '<div class="kw-row kw-slot">' +
            '<input type="color" id="kw-text" value="' + toHex6(textVal) + '">' +
            '<input type="text" id="kw-text-hex" value="' + textVal + '" spellcheck="false" maxlength="7">' +
            '<button class="kw-mini" data-apply="text">应用</button>' +
            '<button class="kw-mini kw-clear" data-clear="text" title="清除，回到自动(保证对比度)">↺</button>' +
          "</div>" +

          '<div class="kw-contrast' + (info.ok ? " ok" : " bad") + '" id="kw-contrast">' +
            "字体 <b>" + info.ink + "</b> 与卡片 <b>" + info.surface + "</b> 对比 <b>" +
            info.c.toFixed(2) + ":1</b> · 目标 ≥ " + cfg.contrast + " " +
            (info.ok ? "✓ 达标" : "⚠ 不足，建议自动修正") +
          "</div>" +
          '<div class="kw-row"><button class="kw-mini" data-autofix>按最小对比度自动修正字体</button></div>' +

          '<div class="kw-note">红 / 黄 / 绿 对错色为功能色，始终不变。' +
            "染色强度拉到 0 即让背景与边框回到中性；要连轮廓、字体一起复原，点「清除自定义」。</div>" +
          '<div class="kw-actions">' +
            '<button class="kw-mini kw-base' + (state.base === "light" ? " on" : "") + '" data-base="light" title="默认浅色">☀ 浅色</button>' +
            '<button class="kw-mini kw-base' + (state.base === "dark" ? " on" : "") + '" data-base="dark" title="默认深色">☾ 深色</button>' +
            '<span class="kw-actions-spacer"></span>' +
            '<button class="kw-mini" data-clearall>清除自定义</button>' +
            '<button class="kw-mini primary" data-palette-close>完成</button>' +
          "</div>" +
        "</div>" +
      "</div>";
  }
  function openPalette() { open = true; renderPalette(); ensurePop().classList.add("show"); }
  function closePalette() { open = false; if (pop) pop.classList.remove("show"); }
  function togglePalette() { open ? closePalette() : openPalette(); }

  // ---------------------------------------------------------------- 事件
  function onDocClick(e) {
    var t = e.target;
    if (!t.closest) return;
    if (t.closest("[data-palette-toggle]")) { togglePalette(); return; }
    if (!open) return;
    var base = t.closest("[data-base]");
    if (base) { setBase(base.getAttribute("data-base")); return; }
    var sw = t.closest("[data-swatch]");
    if (sw) { setSlot("accent", sw.getAttribute("data-swatch")); return; }
    var apply = t.closest("[data-apply]");
    if (apply) {
      var name = apply.getAttribute("data-apply");
      var hi = document.getElementById("kw-" + name + "-hex");
      if (hi && isHex(hi.value)) setSlot(name, hi.value);
      return;
    }
    var clear = t.closest("[data-clear]");
    if (clear) { setSlot(clear.getAttribute("data-clear"), null); return; }
    if (t.closest("[data-autofix]")) { autoFixText(); return; }
    if (t.closest("[data-clearall]")) { clearAll(); return; }
    if (t.closest("[data-palette-close]")) { closePalette(); return; }
  }
  function onDocInput(e) {
    var id = e.target.id;
    if (id === "kw-accent" || id === "kw-bg" || id === "kw-text") {
      if (isHex(e.target.value)) setSlot(id.slice(3), e.target.value);
    } else if (id === "kw-strength") {
      setStrength(parseFloat(e.target.value) / 100);
    } else if (id === "kw-accent-hex" || id === "kw-bg-hex" || id === "kw-text-hex") {
      if (isHex(e.target.value)) setSlot(id.slice(3, -4), e.target.value);
    }
  }
  function bindEvents() {
    document.addEventListener("click", onDocClick);
    document.addEventListener("input", onDocInput, true);
    document.addEventListener("change", onDocInput, true);
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && open) closePalette();
    });
  }

  // ---------------------------------------------------------------- 启动
  load();
  cfg = mergeDefaults(null);
  applyBase();     // 明暗由本模块统一设置（exam.html 头部先给了初值，这里同步，无闪）
  refresh();       // 立即按 localStorage 应用，避免闪默认色
  loadConfig();    // 异步读取出厂默认配置 theme.json（失败则用内置兜底）
  loadRemote();    // 异步读取服务端用户配色（权威源），覆盖本地并写入缓存
  startPolling();  // 定时 / 切回页面时跟随其他浏览器、标签页的改动

  if (window.MutationObserver) {
    new MutationObserver(function (ms) {
      for (var i = 0; i < ms.length; i++) {
        if (ms[i].attributeName === "data-theme") {
          var t = document.documentElement.dataset.theme === "dark" ? "dark" : "light";
          state.base = t;   // 明暗变更已由 setBase / applyRemote 负责推送，这里不回写，避免回环
          refresh();
          if (open && document.body) { syncInputs(); updateReadout(); }
          break;
        }
      }
    }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", bindEvents);
  } else {
    bindEvents();
  }

  window.KaoWoTheme = {
    refresh: refresh,
    openPalette: openPalette,
    setBase: setBase,
    setAccent: function (h) { setSlot("accent", h); },
    setBg: function (h) { setSlot("bg", h); },
    setText: function (h) { setSlot("text", h); },
    setStrength: setStrength,
    autoFixText: autoFixText,
    clearAll: clearAll,
    syncNow: pollOnce,
    getState: function () { return JSON.parse(JSON.stringify(state)); }
  };
})();

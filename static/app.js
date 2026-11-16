(function () {
  "use strict";

  var sid = location.pathname.split("/").filter(Boolean).pop();
  var app = document.getElementById("app");
  var modalRoot = document.getElementById("modal-root");
  var LS_KEY = "exam:" + sid;

  var state = { data: null, idx: 0, answers: {}, running: false, saveTimer: null, result: null, filter: "all" };
  var lastSave = 0;

  // ------------------------------------------------------------ 外观
  // 明暗切换按钮已移入调色盘，主题（含 data-theme）完全由 theme.js 管理，这里只留配色入口。
  // 顶栏 / 抽屉 / 结果页共用；圆点用 var(--blue)，自动跟随当前主色。
  function paletteBtnHtml() {
    return '<button class="btn ghost theme-btn" data-palette-toggle title="主题配色：自定义主题色">' +
      '<i class="kw-dot"></i>配色</button>';
  }

  // ------------------------------------------------------------ 窄屏抽屉（纯布局，不碰作答逻辑）
  // 宽度不足，或宽高比过大且屏幕过矮（横屏手机）时启用紧凑布局
  var COMPACT_MQ = "(max-width: 900px), (min-aspect-ratio: 3/2) and (max-height: 620px)";
  var compactMql = window.matchMedia ? window.matchMedia(COMPACT_MQ) : null;

  function setDrawer(open) {
    document.documentElement.classList.toggle("drawer-open", !!open);
    [].forEach.call(document.querySelectorAll("[data-drawer-toggle] .db-label"), function (el) {
      el.textContent = open ? "收起" : "题号";
    });
  }
  function syncCompact() {
    var compact = compactMql ? compactMql.matches : false;
    document.documentElement.classList.toggle("compact", compact);
    if (!compact) setDrawer(false);   // 回到宽屏：卡片恢复常驻，清掉抽屉状态
  }
  function initCompact() {
    if (!compactMql) return;
    syncCompact();
    if (compactMql.addEventListener) compactMql.addEventListener("change", syncCompact);
    else if (compactMql.addListener) compactMql.addListener(syncCompact);
  }
  initCompact();

  function drawerBtnHtml() {
    return '<button class="btn ghost drawer-btn" data-drawer-toggle title="显示 / 隐藏题号卡片">' +
      '<span class="db-icon"></span><span class="db-label">题号</span></button>';
  }
  function drawerHeadHtml(titleText) {
    return '<div class="drawer-head">' +
      '<div class="drawer-title">' + esc(titleText) + "</div>" +
      '<div class="drawer-tools">' + paletteBtnHtml() +
        '<button class="drawer-close" data-drawer-close>收起</button>' +
      "</div>" +
    "</div>";
  }
  function drawerMaskHtml() { return '<div class="drawer-mask" data-drawer-close></div>'; }

  // ------------------------------------------------------------ 工具

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  // ------------------------------------------------------------ LaTeX 公式（KaTeX 本地资源，离线可用）
  // 只处理 $...$ / $$...$$ / \(...\) / \[...\]；坏公式保留原文，不让整题崩。
  var MATH_DELIMS = [
    { left: "$$", right: "$$", display: true },
    { left: "\\[", right: "\\]", display: true },
    { left: "$", right: "$", display: false },
    { left: "\\(", right: "\\)", display: false }
  ];
  function renderMath(root) {
    if (!root || typeof renderMathInElement !== "function") return;
    try {
      renderMathInElement(root, {
        delimiters: MATH_DELIMS,
        throwOnError: false,
        errorColor: "#cc0000",
        ignoredTags: ["script", "noscript", "style", "textarea", "pre", "code", "option"],
        ignoredClasses: ["katex", "no-math"]
      });
    } catch (e) { /* 渲染失败不影响作答 */ }
  }

  function toast(msg) {
    var el = document.getElementById("toast");
    el.textContent = msg;
    el.classList.add("show");
    clearTimeout(el._t);
    el._t = setTimeout(function () { el.classList.remove("show"); }, 2200);
  }

  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    var mm = String(m).padStart(2, "0"), ss = String(s).padStart(2, "0");
    return h > 0 ? h + ":" + mm + ":" + ss : mm + ":" + ss;
  }

  function fmtDuration(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var m = Math.floor(sec / 60);
    return (m > 0 ? m + " 分 " : "") + (sec % 60) + " 秒";
  }

  function isLetter(k) { return /^[A-H]$/.test(k); }

  function blank() {
    return { picked: [], marks: [], unknown: false, text: "", seconds: 0 };
  }

  function ans(qid) {
    if (!state.answers[qid]) state.answers[qid] = blank();
    var a = state.answers[qid];
    if (!Array.isArray(a.picked)) a.picked = [];
    if (!Array.isArray(a.marks)) a.marks = [];
    if (typeof a.text !== "string") a.text = "";
    a.unknown = !!a.unknown;
    a.seconds = a.seconds || 0;
    return a;
  }

  function curQ() { return state.data.questions[state.idx]; }

  function answered(a) {
    return a.picked.length > 0 || String(a.text || "").trim().length > 0;
  }

  // ------------------------------------------------------------ 初始化

  async function init() {
    var res = await fetch("/api/session/" + sid);
    if (!res.ok) {
      app.innerHTML = '<div class="loading">找不到这场考试，可能已结束。</div>';
      return;
    }
    state.data = await res.json();
    state.answers = state.data.answers || {};
    state.idx = Math.min(state.data.current || 0, state.data.questions.length - 1);

    if (state.data.status === "submitted") { loadResult(); return; }

    restoreLocal();
    state.running = true;
    renderExam();
    startTimer();
    setInterval(function () {
      if (!state.running) return;
      if (!document.hidden) ans(curQ().id).seconds++;
      if (Date.now() - lastSave > 20000) save(true);
    }, 1000);
  }

  function restoreLocal() {
    try {
      var raw = JSON.parse(localStorage.getItem(LS_KEY) || "null");
      if (!raw || !raw.answers) return;
      Object.keys(raw.answers).forEach(function (qid) {
        var cur = state.answers[qid];
        var empty = !cur || (!cur.picked.length && !String(cur.text || "").trim() && !cur.unknown);
        if (empty) state.answers[qid] = raw.answers[qid];
      });
      if (typeof raw.idx === "number" && raw.idx >= 0) state.idx = raw.idx;
    } catch (e) { /* 忽略损坏的本地缓存 */ }
  }

  // ------------------------------------------------------------ 考试界面

  function renderExam() {
    app.innerHTML =
      '<header class="topbar">' +
        '<div class="brand"><span class="mark">考</span><span class="ttl">' + esc(state.data.title) + "</span></div>" +
        '<div class="tools">' +
          '<span class="savestate" id="savestate"></span>' +
          '<span class="progress" id="progress"></span>' +
          '<span class="timer' + (state.data.timed ? "" : " plain") + '" id="timer">' +
            (state.data.timed ? fmtClock(state.data.remaining) : "不限时") + "</span>" +
          '<button class="btn primary" id="submitBtn">交卷</button>' +
          paletteBtnHtml() +
          drawerBtnHtml() +
        "</div>" +
      "</header>" +
      drawerMaskHtml() +
      '<main class="exam">' +
        '<section class="panel" id="panel"></section>' +
        '<aside class="sheet answer-sheet">' +
          drawerHeadHtml(state.data.title) +
          "<h3>答题卡<span id=\"sheetCount\"></span></h3>" +
          '<div class="sub">点击题号可跳转</div>' +
          '<div class="grid" id="grid"></div>' +
          '<div class="legend">' +
            '<span><i class="lg-done"></i>已答</span>' +
            '<span><i class="lg-todo"></i>未答</span>' +
            '<span><i class="lg-mark"></i>有存疑选项</span>' +
            '<span><i class="lg-unknown"></i>不会做</span>' +
          "</div>" +
        "</aside>" +
      "</main>";

    document.getElementById("submitBtn").onclick = askSubmit;
    document.getElementById("grid").onclick = function (e) {
      var cell = e.target.closest(".cell");
      if (cell) { setDrawer(false); go(Number(cell.dataset.i)); }
    };
    renderQuestion();
    renderSheet();
    setDrawer(false);
  }

  function renderQuestion() {
    var q = curQ(), a = ans(q.id), n = state.data.questions.length;
    var headMark = a.marks.length
      ? '<span class="sep">·</span><span style="color:var(--amber)">已标 ' + a.marks.length + " 个存疑选项</span>"
      : "";

    var body = "";
    if (q.type === "fill") {
      body = '<input class="field" id="textInput" type="text" autocomplete="off" placeholder="填写答案" value="' + esc(a.text) + '">';
    } else if (q.type === "short") {
      body = '<textarea class="field" id="textInput" placeholder="写下你的答案，交卷后由老师批改">' + esc(a.text) + "</textarea>";
    } else {
      body = '<div class="options">' + q.options.map(function (o) {
        var sel = a.picked.indexOf(o.key) >= 0;
        var mk = a.marks.indexOf(o.key) >= 0;
        return '<div class="opt' + (sel ? " selected" : "") + '" data-k="' + esc(o.key) + '">' +
          '<span class="dot' + (q.type === "multiple" ? " square" : "") + '"></span>' +
          (isLetter(o.key) ? '<span class="key">' + esc(o.key) + "</span>" : "") +
          '<span class="txt">' + esc(o.text) + "</span>" +
          '<button class="markbtn' + (mk ? " on" : "") + '" data-mark="' + esc(o.key) +
            '" title="标记这个选项没掌握（可与是否选中无关）">?</button>' +
        "</div>";
      }).join("") + "</div>";
    }

    document.getElementById("panel").innerHTML =
      '<div class="qhead">' +
        '<span class="no">第 ' + (state.idx + 1) + " 题</span>" +
        '<span class="sep">/</span><span>' + esc(q.type_label) + "</span>" +
        '<span class="sep">·</span><span>' + q.score + " 分</span>" +
        headMark +
        '<span class="score">共 ' + n + " 题</span>" +
      "</div>" +
      '<div class="stem">' + esc(q.stem) + "</div>" +
      body +
      '<div class="qfoot">' +
        '<div class="nav-group">' +
          '<button class="btn" id="prevBtn"' + (state.idx === 0 ? " disabled" : "") + ">上一题</button>" +
          '<button class="btn" id="nextBtn"' + (state.idx === n - 1 ? " disabled" : "") + ">下一题</button>" +
        "</div>" +
        '<button class="unknown-btn' + (a.unknown ? " on" : "") + '" id="unknownBtn" title="不会做：本题按 0 分计">' +
          "不会做" + (a.unknown ? " ✓" : "") + "</button>" +
      "</div>";

    var panel = document.getElementById("panel");
    renderMath(panel);
    panel.onclick = onPanelClick;

    var input = document.getElementById("textInput");
    if (input) {
      input.oninput = function () {
        var a2 = ans(q.id);
        a2.text = input.value;
        if (a2.text.trim()) a2.unknown = false;
        renderSheet();
        scheduleSave();
      };
    }
  }

  function onPanelClick(e) {
    var q = curQ(), a = ans(q.id);
    // 拖选/复制选项文字时不要误改答案；新一次 mousedown 会自动清除旧选区
    var sel = window.getSelection && window.getSelection().toString();
    if (sel) return;
    var markBtn = e.target.closest(".markbtn");
    if (markBtn) {
      e.stopPropagation();
      toggleMark(a, markBtn.dataset.mark);
      return;
    }
    var opt = e.target.closest(".opt");
    if (opt) { pick(a, q, opt.dataset.k); return; }
    var id = e.target.id;
    if (id === "prevBtn") return go(state.idx - 1);
    if (id === "nextBtn") return go(state.idx + 1);
    if (id === "unknownBtn") return toggleUnknown(a);
  }

  function pick(a, q, key) {
    if (a.unknown) a.unknown = false;
    if (q.type === "multiple") {
      var i = a.picked.indexOf(key);
      if (i >= 0) a.picked.splice(i, 1); else a.picked.push(key);
      a.picked.sort();
    } else {
      a.picked = a.picked.length === 1 && a.picked[0] === key ? [] : [key];
    }
    renderQuestion();
    renderSheet();
    scheduleSave();
  }

  function toggleMark(a, key) {
    var i = a.marks.indexOf(key);
    if (i >= 0) a.marks.splice(i, 1); else a.marks.push(key);
    a.marks.sort();
    renderQuestion();
    renderSheet();
    scheduleSave();
  }

  function toggleUnknown(a) {
    a.unknown = !a.unknown;
    if (a.unknown && state.idx < state.data.questions.length - 1) {
      go(state.idx + 1);  // 标记不会做后直接进入下一题，作答内容原样保留
      save(false);        // 立即落盘，避免刚标记就关页面丢状态
      return;
    }
    renderQuestion();
    renderSheet();
    save(false);
  }

  function go(i) {
    if (i < 0 || i >= state.data.questions.length) return;
    state.idx = i;
    renderQuestion();
    renderSheet();
    scheduleSave();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function renderSheet() {
    var qs = state.data.questions;
    var done = 0, unknown = 0, marked = 0;
    var html = qs.map(function (q, i) {
      var a = ans(q.id);
      var cls = ["cell"];
      if (a.unknown) { cls.push("unknown"); unknown++; done++; }
      else if (answered(a)) { cls.push("done"); done++; }
      if (a.marks.length) { cls.push("mark"); marked += a.marks.length; }
      if (i === state.idx) cls.push("current");
      return '<button class="' + cls.join(" ") + '" data-i="' + i + '">' + (i + 1) + "</button>";
    }).join("");

    document.getElementById("grid").innerHTML = html;
    document.getElementById("progress").textContent = "已答 " + done + " / " + qs.length;
    document.getElementById("sheetCount").textContent = done + "/" + qs.length + (marked ? " · 存疑 " + marked : "");
  }

  // ------------------------------------------------------------ 保存 / 交卷

  function scheduleSave() {
    clearTimeout(state.saveTimer);
    state.saveTimer = setTimeout(function () { save(false); }, 700);
  }

  async function save(silent) {
    if (!state.running) return;
    lastSave = Date.now();
    try {
      localStorage.setItem(LS_KEY, JSON.stringify({ answers: state.answers, idx: state.idx }));
    } catch (e) { /* 忽略容量错误 */ }
    try {
      var res = await fetch("/api/session/" + sid + "/save", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: state.answers, current: state.idx })
      });
      if (!res.ok) throw new Error("save failed");
      var el = document.getElementById("savestate");
      if (el) el.textContent = "已保存 " + new Date().toTimeString().slice(0, 5);
    } catch (e) {
      if (!silent) toast("保存失败，答案已存在本地");
    }
  }

  function askSubmit() {
    var qs = state.data.questions;
    var done = 0, unknown = 0, marks = 0, pending = 0;
    qs.forEach(function (q) {
      var a = ans(q.id);
      if (a.unknown) { unknown++; done++; }
      else if (answered(a)) done++;
      marks += a.marks.length;
      if (q.type === "short" && answered(a)) pending++;
    });
    var left = qs.length - done;

    modalRoot.innerHTML =
      '<div class="overlay" id="overlay"><div class="modal">' +
        "<h2>确认交卷？</h2><p>交卷后不能再修改答案，简答题会留给老师批改。</p>" +
        '<div class="stat-row">' +
          "<div class=\"stat\"><b>" + done + "</b><span>已答</span></div>" +
          '<div class="stat' + (left ? " warn" : "") + '"><b>' + left + "</b><span>未答</span></div>" +
          "<div class=\"stat\"><b>" + marks + "</b><span>存疑选项</span></div>" +
        "</div>" +
        '<div class="actions">' +
          '<button class="btn ghost" id="cancelSubmit">再检查一下</button>' +
          '<button class="btn primary" id="doSubmit">确认交卷</button>' +
        "</div>" +
      "</div></div>";

    document.getElementById("cancelSubmit").onclick = function () { modalRoot.innerHTML = ""; };
    document.getElementById("doSubmit").onclick = function () { doSubmit(false); };
  }

  async function doSubmit(auto) {
    if (!state.running) return;
    state.running = false;
    modalRoot.innerHTML = "";
    try {
      var res = await fetch("/api/session/" + sid + "/submit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers: state.answers })
      });
      if (!res.ok) throw new Error("submit failed");
      var data = await res.json();
      localStorage.removeItem(LS_KEY);
      showResult(data);
      if (auto) toast("时间到，已自动交卷");
    } catch (e) {
      state.running = true;
      toast("交卷失败，请再试一次");
    }
  }

  // ------------------------------------------------------------ 计时

  function startTimer() {
    var el = document.getElementById("timer");
    if (!state.data.timed) return;  // 不限时：不启动倒计时，也不自动交卷
    function tick() {
      if (!state.data) return;
      var left = state.data.deadline - Date.now() / 1000;
      if (left <= 0 && state.running) {
        el.textContent = "00:00";
        doSubmit(true);
        return;
      }
      if (!state.running) return;
      el.textContent = fmtClock(left);
      el.classList.toggle("warn", left <= 300);
      if (left <= 300 && !el.dataset.warned) {
        el.dataset.warned = "1";
        toast("剩余不到 5 分钟");
      }
      setTimeout(tick, 500);
    }
    tick();
  }

  // ------------------------------------------------------------ 结果页

  async function loadResult() {
    try {
      var res = await fetch("/api/session/" + sid + "/result");
      if (!res.ok) throw new Error("no result");
      showResult(await res.json());
    } catch (e) {
      app.innerHTML = '<div class="loading">结果还没生成，请刷新重试。</div>';
    }
  }

  function showResult(r) {
    state.result = r;
    var pct = r.auto_total > 0 ? Math.round((r.score / r.auto_total) * 100) : 0;
    var weak = r.weak_options || [];

    app.innerHTML =
      '<header class="topbar">' +
        '<div class="brand"><span class="mark">绩</span><span class="ttl">' + esc(r.title) + "</span></div>" +
        '<div class="tools">' +
          '<span class="progress">用时 ' + fmtDuration(r.duration_seconds) + "</span>" +
          paletteBtnHtml() +
          drawerBtnHtml() +
        "</div>" +
      "</header>" +
      drawerMaskHtml() +
      '<div class="result">' +
        '<div class="result-main">' +
          '<div class="scorecard">' +
            '<div class="ring" style="--p:' + pct + '"><div class="inner"><div><b>' + r.score + "</b><br><small>/ " + r.auto_total + " 分</small></div></div></div>" +
            '<div class="headline">' +
              "<h2>交卷完成</h2>" +
              "<p>客观题得分率 " + pct + "%，全卷满分 " + r.total + " 分" +
                (r.pending_review.length ? "，另有 " + r.pending_review.length + " 道主观题待批改" : "") + "</p>" +
              '<div class="chips">' +
                '<span class="c g">答对 ' + r.correct + "</span>" +
                '<span class="c r">答错 ' + r.wrong + "</span>" +
                '<span class="c a">不会做 ' + r.unknown + "</span>" +
                '<span class="c a">存疑选项 ' + r.marked_option_count + "</span>" +
              "</div>" +
            "</div>" +
          "</div>" +
          (weak.length ? weakPanel(weak) : "") +
          '<div class="tabs" id="tabs">' +
            tab("all", "全部", r.items.length) +
            tab("wrong", "错题", r.wrong) +
            tab("mark", "有存疑", r.items.filter(function (i) { return i.marks.length; }).length) +
            tab("unknown", "不会做", r.unknown) +
            tab("pending", "待批改", r.pending_review.length) +
          "</div>" +
          '<div id="qlist"></div>' +
        "</div>" +
        '<aside class="result-side">' + drawerHeadHtml(r.title) + jumpSheetHtml() + "</aside>" +
      "</div>";

    renderMath(app);

    document.getElementById("tabs").onclick = function (e) {
      var t = e.target.closest(".tab");
      if (t) applyFilter(t.dataset.f);
    };
    document.getElementById("jumpGrid").onclick = function (e) {
      var c = e.target.closest(".jcell");
      if (c) { setDrawer(false); jumpTo(Number(c.dataset.no)); }
    };
    renderJump(r);
    renderList();
    setDrawer(false);
  }

  function applyFilter(f) {
    state.filter = f;
    [].forEach.call(document.querySelectorAll(".tab"), function (x) {
      x.classList.toggle("on", x.dataset.f === f);
    });
    renderList();
  }

  function jumpSheetHtml() {
    return '<div class="sheet jump-sheet">' +
      '<h3>题号速览<span id="jumpCount"></span></h3>' +
      '<div class="sub">点击题号跳到该题（始终显示）</div>' +
      '<div class="jgrid" id="jumpGrid"></div>' +
      '<div class="legend jump-legend">' +
        '<span><i class="lg-bad"></i>答错/错选</span>' +
        '<span><i class="lg-warn"></i>存疑</span>' +
        '<span><i class="lg-ok"></i>答对</span>' +
        '<span><i class="lg-unk"></i>不会做</span>' +
        '<span><i class="lg-pending"></i>待批改</span>' +
        '<span><i class="lg-todo"></i>未答</span>' +
      "</div>" +
    "</div>";
  }

  // 颜色优先级：红(答错/错选/漏选) > 黄(存疑) > 绿(答对)
  function jumpClass(i) {
    if (i.unknown) return "j-unk";
    if (i.needs_review) return "j-pending";
    if (i.correct === false) return "j-bad";
    if (i.marks.length) return "j-warn";
    if (i.correct === true) return "j-ok";
    return "";
  }

  function renderJump(r) {
    var box = document.getElementById("jumpGrid");
    if (!box) return;
    box.innerHTML = r.items.map(function (i, idx) {
      var no = idx + 1;
      return '<button class="jcell ' + jumpClass(i) + '" data-no="' + no + '">' + no + "</button>";
    }).join("");
    var cnt = document.getElementById("jumpCount");
    if (cnt) cnt.textContent = "共 " + r.items.length + " 题";
  }

  function jumpTo(no) {
    var el = document.getElementById("qcard-" + no);
    if (!el) { applyFilter("all"); el = document.getElementById("qcard-" + no); }
    if (!el) return;
    el.scrollIntoView({ behavior: "smooth", block: "start" });
    [].forEach.call(document.querySelectorAll("#jumpGrid .jcell"), function (c) {
      c.classList.toggle("on", Number(c.dataset.no) === no);
    });
  }

  function tab(key, label, n) {
    return '<button class="tab' + (state.filter === key ? " on" : "") + '" data-f="' + key + '">' + label +
      (n ? " " + n : "") + "</button>";
  }

  function weakPanel(list) {
    return '<div class="weak"><h3>你标了存疑的选项（' + list.length + "）</h3>" +
      "<p>这些是自认没掌握的点，讲题时按这个顺序过。</p><ul>" +
      list.map(function (w) {
        return "<li><b>第" + w.no + "题 " + esc(w.key) + "</b><span>" + esc(cut(w.stem, 46)) +
          "</span><em>" + (w.picked ? "已选" : "未选") + "</em></li>";
      }).join("") + "</ul></div>";
  }

  function cut(s, n) {
    s = String(s || "").replace(/\s+/g, " ");
    return s.length > n ? s.slice(0, n) + "…" : s;
  }

  function renderList() {
    var r = state.result;
    var items = r.items.filter(function (i) {
      if (state.filter === "wrong") return i.correct === false && !i.unknown;
      if (state.filter === "mark") return i.marks.length > 0;
      if (state.filter === "unknown") return i.unknown;
      if (state.filter === "pending") return i.needs_review;
      return true;
    });
    var box = document.getElementById("qlist");
    if (!items.length) {
      box.innerHTML = '<div class="loading">这个分类下没有题目。</div>';
      return;
    }
    box.innerHTML = items.map(function (i) {
      return qcard(i, r.items.indexOf(i) + 1);
    }).join("");
    renderMath(box);
  }

  function qcard(i, no) {
    var cls = "qcard ";
    if (i.unknown) cls += "unk";
    else if (i.needs_review) cls += "pending";
    else if (i.correct) cls += "ok";
    else cls += "bad";

    var verdict = i.unknown ? "不会做" : i.needs_review ? "待批改" : i.correct ? "答对" : "答错";

    var body = "";
    if (i.options.length) {
      var multi = i.type === "multiple";
      body = '<div class="options">' + i.options.map(function (o) {
        var right = i.answer.indexOf(o.key) >= 0;
        var mine = i.picked.indexOf(o.key) >= 0;
        var mk = i.marks.indexOf(o.key) >= 0;
        var wrongPick = mine && !right;            // 错选：选了非答案项
        var missed = right && !mine && multi;      // 漏选：多选里该选却没选

        // 行色优先级：红(错选/漏选) > 黄(存疑) > 绿(正确项)
        var tone = "";
        if (wrongPick || missed) tone = " o-red";
        else if (mk) tone = " o-amber";
        else if (right) tone = " o-green";

        // 标签：正确答案 与 你的选择 允许共存（正确且选中时两个都显示）
        var tags = [];
        if (right) tags.push('<span class="tag">正确答案</span>');
        if (mine) tags.push('<span class="tag ' + (right ? "blue" : "red") + '">你的选择' +
          (wrongPick ? "·错选" : "") + "</span>");
        if (missed) tags.push('<span class="tag red">漏选</span>');
        if (mk) tags.push('<span class="tag amber">存疑</span>');

        return '<div class="opt' + tone + '">' +
          '<span class="dot' + (i.type === "multiple" ? " square" : "") + (right || mine ? " filled" : "") + '"></span>' +
          (isLetter(o.key) ? '<span class="key">' + esc(o.key) + "</span>" : "") +
          '<span class="txt">' + esc(o.text) + "</span>" +
          (tags.length ? '<span class="tags">' + tags.join("") + "</span>" : "") +
        "</div>";
      }).join("") + "</div>";
    }

    var compare = "";
    if (i.type === "fill" || i.type === "short") {
      compare = '<div class="compare">你的答案：<b class="' + (i.correct ? "right" : "yours") + '">' +
        (esc(i.picked_text) || "（空）") + "</b><br>参考答案：<b class=\"right\">" + esc(i.answer_text) + "</b></div>";
    } else {
      compare = '<div class="compare">你的答案：<b class="' + (i.correct ? "right" : "yours") + '">' +
        (esc(i.picked_text) || "（空）") + '</b> ｜ 正确答案：<b class="right">' + esc(i.answer_text) + "</b>" +
        (i.marks.length ? " ｜ 存疑：" + esc(i.marks_text) : "") + "</div>";
    }

    return '<article id="qcard-' + no + '" class="' + cls + '">' +
      '<div class="qhead"><span class="no">第 ' + no + " 题</span><span class=\"sep\">/</span>" +
        "<span>" + esc(i.type_label) + '</span><span class="sep">·</span><span>' + i.score + " 分</span>" +
        '<span class="score" style="color:var(--ink-3)">' + verdict +
        (i.earned != null ? " · " + i.earned + " 分" : "") + "</span></div>" +
      '<div class="stem">' + esc(i.stem) + "</div>" +
      body + compare +
      (i.explanation ? '<div class="explain"><b>解析</b><br>' + esc(i.explanation) + "</div>" : "") +
    "</article>";
  }

  // ------------------------------------------------------------ 键盘

  document.addEventListener("keydown", function (e) {
    if (!state.running || !state.data) return;
    var tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    var q = curQ(), a = ans(q.id);

    if (e.key === "ArrowLeft") { e.preventDefault(); return go(state.idx - 1); }
    if (e.key === "ArrowRight") { e.preventDefault(); return go(state.idx + 1); }
    if (e.key === "u" || e.key === "U") { e.preventDefault(); return toggleUnknown(a); }
    if (/^[1-8]$/.test(e.key)) {
      var i = Number(e.key) - 1;
      if (i < q.options.length) { e.preventDefault(); pick(a, q, q.options[i].key); }
    }
  });

  // 全部用事件委托：顶栏/抽屉重建后仍有效（只做 UI 开关，不触碰作答逻辑）
  document.addEventListener("click", function (e) {
    if (!e.target.closest) return;
    if (e.target.closest("[data-drawer-toggle]")) {
      setDrawer(!document.documentElement.classList.contains("drawer-open"));
      return;
    }
    if (e.target.closest("[data-drawer-close]")) { setDrawer(false); return; }
  });

  init();
})();

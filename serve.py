#!/usr/bin/env python3
"""KaoWo 考场：独立 HTTP 守护进程（不依赖 MCP / harness，可后台常驻）。

用法
    python serve.py --start            后台启动（脱离控制台与 job），默认 1230，被占则退化随机端口
    python serve.py --status           查看 pid / 实际端口 / 活跃会话
    python serve.py --stop             停止
    python serve.py --run              前台运行（调试，Ctrl+C 退出）
    python serve.py --run --port 1231  指定端口前台运行

启动后题库由网址参数决定，不需要 MCP 开考：
    http://127.0.0.1:1230/take?bank=生理学-第09章_选择题全量
    http://127.0.0.1:1230/take?bank=示例-生理学&minutes=20&limit=10&order=random
同一题库再次访问会续上还没有交卷的那一场，要重开就加 &fresh=1。
"""
from __future__ import annotations

import argparse
import ctypes
import html
import json
import os
import random
import socket
import subprocess
import sys
import threading
import time
import uuid
from http.server import ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT))

import server as srv  # 复用题库读取、判分、落盘、页面路由

STATE_FILE = ROOT / "data" / "serve.json"
LOG_FILE = ROOT / "data" / "serve.log"
DEFAULT_PORT = int(os.environ.get("EXAM_PORT", "1230"))
PORT = 0

# Windows 进程创建标志
DETACHED_PROCESS = 0x00000008
CREATE_NEW_PROCESS_GROUP = 0x00000200
CREATE_BREAKAWAY_FROM_JOB = 0x01000000
CREATE_NO_WINDOW = 0x08000000
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000
STILL_ACTIVE = 259


# ---------------------------------------------------------------- 日志 / 状态

def _log(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%d %H:%M:%S')} {msg}"
    try:
        LOG_FILE.parent.mkdir(parents=True, exist_ok=True)
        if LOG_FILE.exists() and LOG_FILE.stat().st_size > 2 * 1024 * 1024:
            LOG_FILE.write_text("", encoding="utf-8")
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except OSError:
        pass
    try:
        if sys.stdout is not None:
            print(line, flush=True)
    except Exception:
        pass


def _read_state() -> dict:
    try:
        data = json.loads(STATE_FILE.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else {}
    except (OSError, ValueError):
        return {}


def _write_state(port: int) -> None:
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "pid": os.getpid(),
        "port": port,
        "bind": srv.BIND_HOST,
        "url": f"http://127.0.0.1:{port}",
        "lan": _lan_ips(port),
        "started": time.time(),
        "started_at": time.strftime("%Y-%m-%d %H:%M:%S"),
        "root": str(ROOT),
    }
    tmp = STATE_FILE.with_suffix(".tmp")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, STATE_FILE)


def _drop_state() -> None:
    try:
        STATE_FILE.unlink()
    except OSError:
        pass


def _lan_ips(port: int) -> list[str]:
    ips: list[str] = []
    try:
        sock = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        sock.settimeout(0.2)
        sock.connect(("10.255.255.255", 1))
        ip = sock.getsockname()[0]
        sock.close()
        if ip and not ip.startswith("127."):
            ips.append(f"http://{ip}:{port}")
    except OSError:
        pass
    return ips


def _pid_alive(pid: int) -> bool:
    if not pid:
        return False
    kernel32 = ctypes.windll.kernel32
    handle = kernel32.OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, False, int(pid))
    if not handle:
        return False
    try:
        code = ctypes.c_ulong()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def _health(port: int) -> dict | None:
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/health", timeout=2) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except Exception:
        return None


# ---------------------------------------------------------------- 会话

def _snapshot_ok(sess: dict) -> bool:
    """会话能不能打开，取决于 banks/_session_<sid>.json 还在不在（题目只存在快照里）。"""
    bank = sess.get("bank") or ""
    return bool(bank) and (srv.BANKS_DIR / f"{srv._slug(bank)}.json").exists()


def _same_bank(sess: dict, data: dict, key: str, title: str) -> bool:
    """判断老会话是不是这个题库开的。

    新会话有 bank_src，直接比 id。老会话没有 bank_src：先比标题，标题对不上
    （题库后来被加了「学科-」前缀）就退回比对首题题干，避免同一个题库被重复开考。
    """
    if sess.get("bank_src"):
        return sess["bank_src"] == key
    if title and sess.get("title") == title:
        return True
    snap = srv.BANKS_DIR / f"{srv._slug(sess.get('bank') or '')}.json"
    try:
        sub = json.loads(snap.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return False
    stems = [((sub.get("questions") or [{}])[0]).get("stem"),
             ((data.get("questions") or [{}])[0]).get("stem")]
    return bool(stems[0] and stems[1] and stems[0] == stems[1])


def _find_running(bank_key: str, data: dict) -> dict | None:
    """找同一题库里还没有交卷的那一场，用于网址重复访问时续答。

    新会话带 bank_src 精确匹配；老会话（MCP 开考、没有 bank_src）退回按标题匹配，
    这样用网址打开旧题库不会另起一场。
    """
    key = srv._slug(data.get("id") or bank_key)
    title = data.get("title") or ""
    with srv._LOCK:
        candidates = list(srv.SESSIONS.values())
    for sess in candidates:
        if sess.get("status") != "running" or not _snapshot_ok(sess):
            continue
        if _same_bank(sess, data, key, title):
            return sess
    for path in srv.DATA_DIR.glob("*.json"):
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if not isinstance(row, dict) or row.get("status") != "running" or not _snapshot_ok(row):
            continue
        if _same_bank(row, data, key, title):
            with srv._LOCK:
                return srv.SESSIONS.setdefault(row["id"], row)
    return None


def _question_count(sess: dict) -> int | None:
    try:
        return len(srv.load_bank(sess["bank"]).get("questions") or [])
    except ValueError:  # 快照被清掉的旧会话
        return sess.get("question_count")


def _create_session(data: dict, minutes: int = 0, limit: int = 0, order: str = "original") -> dict:
    questions = list(data["questions"])
    if order == "random":
        random.shuffle(questions)
    if limit and 0 < limit < len(questions):
        questions = questions[:limit]

    sid = uuid.uuid4().hex[:8]
    sub = dict(data)
    sub["id"] = f"_session_{sid}"
    sub["questions"] = questions
    (srv.BANKS_DIR / f"_session_{sid}.json").write_text(
        json.dumps(sub, ensure_ascii=False), encoding="utf-8")

    now = srv._now()
    minutes = max(0, int(minutes))
    sess = {
        "id": sid,
        "bank": sub["id"],
        "bank_src": data.get("id") or "bank",
        "title": data.get("title", data.get("id", sid)),
        "question_count": len(questions),
        "order": order,
        "started": now,
        "deadline": now + minutes * 60 if minutes else 0,
        "minutes": minutes,
        "status": "running",
        "answers": {},
        "current": 0,
        "result": None,
        "submitted_at": None,
        "port": PORT,
        "origin": "serve",
    }
    with srv._LOCK:
        srv.SESSIONS[sid] = sess
        srv._persist(sess)
    _log(f"开考 sid={sid} bank={sess['bank_src']} 题数={len(questions)} 限时={minutes}")
    return sess


def _preload() -> int:
    """只把本守护进程自己开过的进行中会话装进内存。

    历史会话（MCP 开的、别人开的）不预载，访问时才按需加载，避免常驻内存膨胀；
    限时考试关掉浏览器后也能到点自动交卷，因此 watch 也只看 origin=serve 的会话。
    """
    loaded = 0
    for path in srv.DATA_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(data, dict) and data.get("status") == "running" and data.get("origin") == "serve" and data.get("id"):
            with srv._LOCK:
                srv.SESSIONS.setdefault(data["id"], data)
            loaded += 1
    return loaded


def _watch_loop() -> None:
    while True:
        time.sleep(10)
        try:
            with srv._LOCK:
                current = list(srv.SESSIONS.values())
            for sess in current:
                if sess.get("status") == "running" and sess.get("origin") == "serve":
                    srv._auto_submit_if_due(sess)
        except Exception as exc:  # 单次异常不能弄死守护线程
            _log(f"watch error: {type(exc).__name__}: {exc}")


# ---------------------------------------------------------------- HTTP

def _bank_rows() -> str:
    rows = []
    for bank in srv.scan_banks():
        total = bank.get("total_score", 0)
        types = "、".join(f"{srv.TYPE_LABEL.get(k, k)}{v}" for k, v in (bank.get("types") or {}).items())
        link = f"/take?bank={quote(bank['id'])}"
        rows.append(
            "<tr>"
            f"<td class='t'>{html.escape(bank.get('title') or bank['id'])}</td>"
            f"<td class='n'>{bank.get('count', 0)}</td>"
            f"<td class='n'>{total:g}</td>"
            f"<td class='d'>{html.escape(types)}</td>"
            f"<td><a class='go' href=\"{html.escape(link)}\">开考</a></td>"
            "</tr>"
        )
    return "".join(rows) or "<tr><td colspan='5' class='d'>banks/ 里还没有题库</td></tr>"


def _recent_sessions(limit: int = 20) -> list[dict]:
    """列出最近会话：内存里的优先，其余按文件 mtime 现读现扔，不常驻内存。"""
    rows: dict[str, dict] = {}
    with srv._LOCK:
        for sess in srv.SESSIONS.values():
            if sess.get("id"):
                rows[sess["id"]] = sess
    paths = sorted(srv.DATA_DIR.glob("*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    for path in paths[:max(limit, 20)]:
        try:
            row = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        if isinstance(row, dict) and row.get("id"):
            rows.setdefault(row["id"], row)
    ordered = sorted(rows.values(), key=lambda s: s.get("started") or 0, reverse=True)
    return ordered[:limit]


def _session_rows() -> str:
    rows = []
    for sess in _recent_sessions(20):
        answers = sess.get("answers") or {}
        done = sum(1 for v in answers.values() if v.get("picked") or v.get("text") or v.get("unknown"))
        status = "进行中" if sess.get("status") == "running" else "已交卷"
        broken = not _snapshot_ok(sess)
        if broken:
            status += " · 题库快照已删，打不开"
        started = time.strftime("%m-%d %H:%M", time.localtime(sess.get("started") or 0))
        action = (f"<span class='d'>不可用</span>" if broken else
                  f"<a class='go' href=\"/exam/{html.escape(str(sess.get('id')))}\">进入</a>")
        rows.append(
            "<tr>"
            f"<td class='mono'>{html.escape(str(sess.get('id')))}</td>"
            f"<td class='t'>{html.escape(str(sess.get('title') or ''))}</td>"
            f"<td class='n'>{done}</td>"
            f"<td class='d'>{status} · {started}</td>"
            f"<td>{action}</td>"
            "</tr>"
        )
    return "".join(rows) or "<tr><td colspan='5' class='d'>还没有会话，先在上面按题库开一场</td></tr>"


_INDEX_CSS = """
:root{--bg:#0f1115;--fg:#e7e9ee;--mut:#9aa3b2;--line:#242a33;--acc:#3d7bfd;}
*{box-sizing:border-box}
body{margin:0;padding:28px 24px 48px;background:var(--bg);color:var(--fg);
 font:14px/1.6 -apple-system,"Segoe UI","Microsoft YaHei",sans-serif}
h1{margin:0 0 4px;font-size:20px;font-weight:600}
h2{margin:28px 0 10px;font-size:15px;font-weight:600;color:var(--mut)}
.meta{color:var(--mut);font-size:12px;margin-bottom:18px}
form{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin:0 0 6px}
input,select{background:#161a21;color:var(--fg);border:1px solid var(--line);
 border-radius:8px;padding:8px 10px;font:inherit;min-width:0}
input[type=text]{flex:1 1 320px}
button{background:var(--acc);color:#fff;border:0;border-radius:8px;padding:9px 16px;
 font:inherit;cursor:pointer}
table{width:100%;border-collapse:collapse;font-size:13px}
th,td{padding:8px 10px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--mut);font-weight:500}
td.n{width:64px;text-align:right;font-variant-numeric:tabular-nums;color:var(--mut)}
td.t{max-width:46%}
td.d{color:var(--mut);font-size:12px}
td.mono{font-family:ui-monospace,Consolas,monospace;color:var(--mut);width:90px}
a.go{color:var(--acc);text-decoration:none;white-space:nowrap}
a.go:hover{text-decoration:underline}
.hint{color:var(--mut);font-size:12px;margin:6px 0 0}
"""


def _index_html() -> str:
    state = _read_state()
    served = state.get("port") or PORT
    return f"""<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>KaoWo 考场服务</title><style>{_INDEX_CSS}</style></head>
<body>
<h1>KaoWo 考场服务</h1>
<div class="meta">pid {state.get('pid', '-')} · 实际端口 {served} · 绑定 {html.escape(str(state.get('bind', srv.BIND_HOST)))} · 启动 {html.escape(str(state.get('started_at', '-')))}</div>

<form action="/take" method="get">
  <input type="text" name="bank" placeholder="题库 id 或文件名，例如 生理学-第09章_选择题全量" required>
  <input type="text" name="minutes" placeholder="限时分钟，0 不限" style="flex:0 0 130px">
  <input type="text" name="limit" placeholder="抽题数，0 全部" style="flex:0 0 120px">
  <select name="order"><option value="original">原顺序</option><option value="random">打乱</option></select>
  <label style="color:var(--mut)"><input type="checkbox" name="fresh" value="1"> 强制新开</label>
  <button type="submit">开考</button>
</form>
<p class="hint">网址即参数 <code>/take?bank=题库id&amp;minutes=0&amp;limit=0&amp;order=original&amp;fresh=1</code>，同一题库再访问会续上未交卷的那一场。</p>

<h2>题库</h2>
<table><thead><tr><th>题库</th><th>题量</th><th>总分</th><th>题型</th><th></th></tr></thead>
<tbody>{_bank_rows()}</tbody></table>

<h2>会话（最近 20 场）</h2>
<table><thead><tr><th>sid</th><th>题库</th><th>已答</th><th>状态</th><th></th></tr></thead>
<tbody>{_session_rows()}</tbody></table>
</body></html>"""


class ServeHandler(srv.Handler):
    """在原有路由之上加 / 首页与 /take，其余 /exam、/static、/api 全部沿用。"""

    def _route_get(self):
        path = urlparse(self.path).path
        if path in ("/", "/index.html"):
            return self._send(200, _index_html().encode("utf-8"), "text/html; charset=utf-8")
        if path == "/take":
            return self._take()
        if path == "/api/banks":
            return self._json({"banks": srv.scan_banks()})
        if path == "/api/sessions":
            raw_limit = (parse_qs(urlparse(self.path).query).get("limit") or ["50"])[0]
            try:
                limit = max(1, min(200, int(raw_limit)))
            except ValueError:
                limit = 50
            items = [{k: s.get(k) for k in ("id", "title", "status", "started", "minutes", "bank_src")}
                     for s in _recent_sessions(limit)]
            return self._json({"sessions": items})
        if path == "/favicon.ico":
            return self._send(204, b"", "image/x-icon")
        return super()._route_get()

    def _take(self):
        query = parse_qs(urlparse(self.path).query)

        def one(key: str, default: str = "") -> str:
            values = query.get(key)
            return (values[0] if values else default).strip()

        sid = one("session") or one("sid")
        if sid:
            try:
                srv._get_session(sid)
            except ValueError as exc:
                return self._json({"error": str(exc)}, 404)
            return self._goto(f"/exam/{sid}")

        bank = one("bank") or one("id")
        if not bank:
            return self._text("用法：/take?bank=题库id[&minutes=45][&limit=50][&order=random][&fresh=1]\n", 400)

        def as_int(key: str, default: int) -> int:
            try:
                return max(0, int(one(key) or default))
            except ValueError:
                return default

        minutes = as_int("minutes", 0)
        limit = as_int("limit", 0)
        order = one("order", "original") or "original"
        fresh = one("fresh").lower() in ("1", "true", "yes", "on")

        try:
            bank_data = srv.load_bank(bank)
        except ValueError as exc:
            return self._json({"error": str(exc)}, 404)

        sess = None if fresh else _find_running(bank, bank_data)
        reused = sess is not None
        if sess is not None:
            # 显式传了与老会话不同的 minutes / limit / order，按“要新开一场”处理，
            # 否则用户改参数刷新网址会被静默忽略，还以为抽题数生效了。
            old_minutes = int(sess.get("minutes") or 0)
            old_limit = int(sess.get("question_count") or _question_count(sess) or 0)
            old_order = sess.get("order")
            changed = (
                (minutes and minutes != old_minutes)
                or (limit and old_limit and limit != old_limit)
                or (old_order and order != old_order)
            )
            if changed:
                _log(f"参数与旧会话不一致，另开一场 sid={sess['id']} (minutes {old_minutes}->{minutes}, "
                     f"limit {old_limit}->{limit}, order {old_order}->{order})")
                sess, reused = None, False
        if sess is None:
            sess = _create_session(bank_data, minutes=minutes, limit=limit, order=order)

        url = f"http://127.0.0.1:{PORT}/exam/{sess['id']}"
        if one("format") == "json":
            return self._json({
                "ok": True,
                "session_id": sess["id"],
                "url": url,
                "title": sess.get("title"),
                "bank": sess.get("bank_src"),
                "status": sess.get("status"),
                "questions": _question_count(sess),
                "minutes": sess.get("minutes"),
                "reused": reused,
            })
        return self._goto(f"/exam/{sess['id']}")

    def _goto(self, location: str) -> None:
        self.send_response(302)
        self.send_header("Location", location)
        self.send_header("Content-Length", "0")
        self.end_headers()


# ---------------------------------------------------------------- 启停

def _bind(port: int) -> tuple[ThreadingHTTPServer, int]:
    if port:
        probe = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        probe.settimeout(0.2)
        try:
            if probe.connect_ex(("127.0.0.1", port)) == 0:
                _log(f"端口 {port} 已被占用，退化到随机端口")
                port = 0
        finally:
            probe.close()
    try:
        httpd = ThreadingHTTPServer((srv.BIND_HOST, port or 0), ServeHandler)
    except OSError:
        httpd = ThreadingHTTPServer((srv.BIND_HOST, 0), ServeHandler)
    httpd.daemon_threads = True
    return httpd, int(httpd.server_address[1])


def run(port: int) -> int:
    global PORT
    httpd, actual = _bind(port)
    PORT = actual
    srv._httpd = httpd          # 让库内任何 ensure_http 复用同一个实例，不会二次绑定
    srv._port = actual
    loaded = _preload()
    _write_state(actual)
    _log(f"serve 就绪 pid={os.getpid()} port={actual} bind={srv.BIND_HOST} 预载会话={loaded}")
    if sys.stdout is not None:
        print(f"考场服务已就绪： http://127.0.0.1:{actual}/", flush=True)
    threading.Thread(target=_watch_loop, daemon=True, name="exam-watch").start()
    try:
        httpd.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        _log("收到 Ctrl+C，退出")
    finally:
        _drop_state()
        try:
            httpd.server_close()
        except Exception:
            pass
    return 0


def start(port: int) -> int:
    state = _read_state()
    if state and _pid_alive(int(state.get("pid") or 0)):
        print(f"已经在运行：pid {state['pid']} 端口 {state.get('port')}  {state.get('url')}")
        return 0
    _drop_state()

    exe = Path(sys.executable)
    pyw = exe.with_name("pythonw.exe")
    launcher = str(pyw) if pyw.exists() else str(exe)
    cmd = [launcher, str(Path(__file__).resolve()), "--run", "--port", str(port)]
    base_flags = DETACHED_PROCESS | CREATE_NEW_PROCESS_GROUP
    if not pyw.exists():
        base_flags |= CREATE_NO_WINDOW
    kwargs = dict(cwd=str(ROOT), close_fds=True, stdin=subprocess.DEVNULL,
                  stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    launched_at = time.time()
    try:
        proc = subprocess.Popen(cmd, creationflags=base_flags | CREATE_BREAKAWAY_FROM_JOB, **kwargs)
    except OSError:
        proc = subprocess.Popen(cmd, creationflags=base_flags, **kwargs)

    # venv 的 python.exe / pythonw.exe 在部分环境下是转发壳，真正服务的进程 pid 与 Popen 返回的
    # pid 不同，所以这里以“状态文件比启动时刻更新且 pid 存活、健康检查通过”为准。
    for _ in range(60):
        time.sleep(0.25)
        state = _read_state()
        if not state or float(state.get("started") or 0) < launched_at - 1:
            continue
        if _pid_alive(int(state.get("pid") or 0)) and _health(int(state.get("port") or 0)):
            break
    else:
        print("启动失败，请看 data/serve.log")
        return 1

    final = _read_state()
    print(f"已后台启动：pid {final['pid']}  端口 {final['port']}  {final['url']}")
    if final.get("lan"):
        print("局域网：" + "  ".join(final["lan"]))
    if int(final["port"]) != port:
        print(f"注意：{port} 被占用，本实例退化到 {final['port']}，请按上面的网址访问")
    print(f"日志：{LOG_FILE}")
    return 0


def status() -> int:
    state = _read_state()
    if not state:
        print("未运行（没有 data/serve.json）")
        return 1
    pid = int(state.get("pid") or 0)
    alive = _pid_alive(pid)
    health = _health(int(state.get("port") or 0))
    print(f"pid {pid} {'存活' if alive else '已退出'}")
    print(f"端口 {state.get('port')}  绑定 {state.get('bind')}")
    print(f"网址 {state.get('url')}")
    print(f"启动 {state.get('started_at')}")
    print(f"健康检查 {'通过 ' + json.dumps(health, ensure_ascii=False) if health else '不通'}")
    if health:
        print(f"该实例持有会话 {health.get('sessions', 0)} 场")
    return 0 if alive else 1


def stop() -> int:
    state = _read_state()
    pid = int(state.get("pid") or 0) if state else 0
    if not pid:
        print("没有记录到运行中的实例")
        return 1
    if not _pid_alive(pid):
        _drop_state()
        print(f"pid {pid} 已经不在，清理状态文件")
        return 0
    subprocess.run(["taskkill", "/PID", str(pid), "/F"], capture_output=True)
    for _ in range(20):
        time.sleep(0.2)
        if not _pid_alive(pid):
            break
    _drop_state()
    print(f"已停止 pid {pid}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="KaoWo 考场独立 HTTP 守护进程")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--start", action="store_true", help="后台启动（默认端口 1230，被占退化随机）")
    action.add_argument("--stop", action="store_true", help="停止后台实例")
    action.add_argument("--status", action="store_true", help="查看运行状态")
    action.add_argument("--run", action="store_true", help="前台运行")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"监听端口，默认 {DEFAULT_PORT}")
    args = parser.parse_args(argv)

    if args.stop:
        return stop()
    if args.status:
        return status()
    if args.run:
        return run(args.port)
    return start(args.port)


if __name__ == "__main__":
    raise SystemExit(main())

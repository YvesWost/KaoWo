"""exam-mcp：本地题库考试服务（MCP stdio + 本地网页考场）

给 AI 用的工具：
    list_banks()                          列出已导入题库
    import_bank(path)                     导入 xlsx / csv / json 题库
    start_exam(bank, minutes, ...)        开考，返回本地网页地址
    wait_for_submit(session_id, timeout)  等交卷（阻塞轮询）
    get_result(session_id)                取判分结果与存疑选项
    export_result(session_id, out_path)   导出结果表格

运行：python server.py          （stdio，由 MCP 客户端拉起）
题库放到 banks/ 下，会话数据落到 data/sessions/，用户配色落到 data/theme-user.json。
"""

from __future__ import annotations

import csv
import json
import os
import random
import re
import socket
import threading
import time
import unicodedata
import uuid
import webbrowser
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import openpyxl
from openpyxl import Workbook
from openpyxl.styles import Alignment, Font, PatternFill

try:
    from mcp.server.mcpserver import MCPServer
except ImportError:  # mcp 1.x
    from mcp.server.fastmcp import FastMCP as MCPServer

ROOT = Path(__file__).resolve().parent
BANKS_DIR = ROOT / "banks"
DATA_DIR = ROOT / "data" / "sessions"
STATIC_DIR = ROOT / "static"
# 用户配色：服务端持久化，任意 host / 端口 / 浏览器访问都读写同一份文件。
# 与出厂默认配置 static/theme.json 分离，且落在已被 .gitignore 排除的 data/ 下。
THEME_FILE = ROOT / "data" / "theme-user.json"
STATIC_TYPES = {
    ".css": "text/css; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".woff2": "font/woff2",
    ".woff": "font/woff",
    ".ttf": "font/ttf",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
}
for _d in (BANKS_DIR, DATA_DIR):
    _d.mkdir(parents=True, exist_ok=True)

OPTION_TYPES = {"single", "multiple", "judge"}
TYPE_LABEL = {
    "single": "单选题",
    "multiple": "多选题",
    "judge": "判断题",
    "fill": "填空题",
    "short": "简答题",
}
JUDGE_TRUE = {"对", "正确", "是", "√", "T", "TRUE", "Y", "YES", "1"}
JUDGE_FALSE = {"错", "错误", "否", "×", "X", "F", "FALSE", "N", "NO", "0"}

# ---------------------------------------------------------------- 基础工具


def _now() -> float:
    return time.time()


def _slug(name: str) -> str:
    name = re.sub(r'[\\/:*?"<>|]+', "_", name).strip()
    return name or "bank"


def _dump(obj) -> str:
    return json.dumps(obj, ensure_ascii=False, indent=2)


def _squash(text: str) -> str:
    """去掉空白与常见中英文标点，用于填空判分。"""
    text = unicodedata.normalize("NFKC", str(text)).strip().lower()
    return re.sub(r"[\s\u3000,，.。;；:：、!！?？\"'“”‘’()（）\[\]【】<>《》]", "", text)


# ---------------------------------------------------------------- 题库解析

ALIASES = {
    "stem": ["题干", "题目", "问题", "试题", "question", "stem"],
    "answer": ["标准答案", "正确答案", "答案", "answer", "key"],
    "type": ["题型", "类型", "type"],
    "score": ["分值", "分数", "score", "points"],
    "explanation": ["解析", "答案解析", "说明", "explanation"],
    "options": ["选项", "options"],
}
OPT_HEADER = re.compile(r"^(?:选项)?([A-H])(?:项|选项)?$")


def _norm_header(cell) -> str:
    text = unicodedata.normalize("NFKC", str(cell or "")).strip()
    text = text.rstrip(".．、:：")
    return re.sub(r"\s+", "", text)


def _match_header(head: str) -> tuple[str, str] | None:
    """返回 (字段, 选项字母)。"""
    if not head:
        return None
    m = OPT_HEADER.match(head)
    if m:
        return "option", m.group(1)
    low = head.lower()
    for field, names in ALIASES.items():
        for alias in names:
            if low == alias or low.endswith(alias):
                return field, ""
    return None


def _read_table(path: Path) -> list[list[str]]:
    suffix = path.suffix.lower()
    if suffix in {".xlsx", ".xlsm"}:
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        ws = wb.active
        rows = [["" if c is None else str(c).strip() for c in row] for row in ws.iter_rows(values_only=True)]
        wb.close()
        return rows
    if suffix in {".csv", ".tsv", ".txt"}:
        raw = path.read_bytes()
        for enc in ("utf-8-sig", "gb18030", "utf-16"):
            try:
                text = raw.decode(enc)
                break
            except UnicodeDecodeError:
                continue
        else:
            raise ValueError("CSV 编码无法识别，请另存为 UTF-8")
        dialect = csv.excel_tab if suffix == ".tsv" else csv.excel
        return [[c.strip() for c in row] for row in csv.reader(text.splitlines(), dialect)]
    raise ValueError(f"不支持的题库格式：{path.suffix}（支持 xlsx / csv / json）")


def _locate_header(rows: list[list[str]]) -> tuple[int, dict[str, str], list[str]]:
    """在前 15 行里找表头行，返回 (行号, 字段->列索引/字母, 选项字母顺序)。"""
    best = (-1, None, [])
    best_score = -1
    for i, row in enumerate(rows[:15]):
        mapping: dict[str, str] = {}
        opt_keys: list[str] = []
        for j, cell in enumerate(row):
            hit = _match_header(_norm_header(cell))
            if not hit:
                continue
            field, letter = hit
            if field == "option":
                mapping[f"opt:{letter}"] = str(j)
                opt_keys.append(letter)
            elif field not in mapping:
                mapping[field] = str(j)
        score = len(mapping) + (2 if "stem" in mapping else 0)
        if score > best_score:
            best_score = score
            best = (i, mapping, sorted(opt_keys))
    if best[1] is None or "stem" not in best[1]:
        raise ValueError("没找到表头：至少需要一列「题干」，以及「标准答案」列")
    return best[0], best[1], best[2]


def _parse_option_cell(text: str) -> list[dict]:
    """解析导出的「选项」列：'A. 甲 ｜ B. 乙' 或 '对 ｜ 错'。"""
    text = str(text or "").strip()
    if not text:
        return []
    parts = [p.strip() for p in re.split(r"[｜|\n]+", text) if p.strip()]
    options, auto = [], 0
    for part in parts:
        m = re.match(r"^([A-Ha-h])[.．、:：]\s*(.+)$", part)
        if m:
            options.append({"key": m.group(1).upper(), "text": m.group(2).strip()})
        else:
            options.append({"key": chr(ord("A") + auto), "text": part})
            auto += 1
    if all(not re.match(r"^[A-H]$", o["key"]) for o in options) and len(options) == 2:
        options = [{"key": "对", "text": options[0]["text"]}, {"key": "错", "text": options[1]["text"]}]
    return options


def _guess_type(raw_type: str, options: list[dict], answer_raw: str) -> str:
    t = str(raw_type or "")
    if any(k in t for k in ("多选", "多项")):
        return "multiple"
    if "单选" in t or "单项" in t:
        return "single"
    if "判断" in t:
        return "judge"
    if any(k in t for k in ("填空", "名词解释", "简答", "问答", "论述", "计算", "分析")):
        return "short" if "填空" not in t else "fill"
    if options:
        letters = re.findall(r"[A-H]", answer_raw.upper())
        return "multiple" if len(set(letters)) > 1 else "single"
    return "judge" if answer_raw.strip().upper() in (JUDGE_TRUE | JUDGE_FALSE) else "fill"


def _normalize_answer(qtype: str, raw: str, options: list[dict]) -> list[str]:
    raw = str(raw or "").strip()
    if qtype in OPTION_TYPES and options:
        keys = {o["key"] for o in options}
        if qtype == "judge" and raw.upper() not in keys:
            word = "对" if raw.upper() in JUDGE_TRUE else "错" if raw.upper() in JUDGE_FALSE else raw
            for o in options:
                if word and word in o["text"]:
                    return [o["key"]]
            return [word]
        letters = re.findall(r"[A-H]", raw.upper())
        picked = [k for k in dict.fromkeys(letters) if k in keys]
        return picked or ([raw.upper()] if raw.upper() in keys else [])
    if qtype == "fill":
        return [p.strip() for p in re.split(r"[|｜]", raw) if p.strip()] or [raw]
    return [raw]


def parse_bank(path: Path, bank_id: str | None = None) -> dict:
    path = Path(path)
    if path.suffix.lower() == ".json":
        data = json.loads(path.read_text(encoding="utf-8"))
        if "questions" not in data:
            raise ValueError("JSON 里没有 questions 字段")
        data.setdefault("id", bank_id or _slug(path.stem))
        data.setdefault("title", data["id"])
        return data

    rows = _read_table(path)
    head_row, cols, opt_keys = _locate_header(rows)
    questions, skipped = [], 0
    for n, row in enumerate(rows[head_row + 1:], start=1):
        def cell(field: str) -> str:
            idx = cols.get(field)
            return row[int(idx)] if idx is not None and int(idx) < len(row) else ""

        stem = cell("stem").strip()
        if not stem:
            continue
        options = []
        for letter in opt_keys:
            idx = cols.get(f"opt:{letter}")
            text = row[int(idx)].strip() if idx and int(idx) < len(row) else ""
            if text:
                options.append({"key": letter, "text": text})
        if not options and cell("options").strip():
            options = _parse_option_cell(cell("options"))

        qtype = _guess_type(cell("type"), options, cell("answer"))
        if qtype == "judge" and not options:
            options = [{"key": "对", "text": "对"}, {"key": "错", "text": "错"}]
        if qtype in OPTION_TYPES and not options:
            skipped += 1
            continue

        answer = _normalize_answer(qtype, cell("answer"), options)
        if not answer:
            skipped += 1
            continue
        try:
            score = float(cell("score")) if cell("score") else 0
        except ValueError:
            score = 0
        if not score:
            score = {"single": 1, "judge": 1, "multiple": 2, "fill": 2, "short": 5}.get(qtype, 2)

        questions.append({
            "id": f"q{n}",
            "type": qtype,
            "stem": stem,
            "options": options,
            "answer": answer,
            "explanation": cell("explanation").strip(),
            "score": score,
        })

    if not questions:
        raise ValueError("没有解析出任何题目，请检查表头与内容")
    return {
        "id": bank_id or _slug(path.stem),
        "title": path.stem,
        "source": str(path),
        "created": time.strftime("%Y-%m-%d %H:%M:%S"),
        "skipped": skipped,
        "questions": questions,
    }


def load_bank(bank_id: str) -> dict:
    path = BANKS_DIR / f"{_slug(bank_id)}.json"
    if not path.exists():
        raise ValueError(f"题库不存在：{bank_id}。可用：{', '.join(b['id'] for b in scan_banks()) or '无'}")
    return json.loads(path.read_text(encoding="utf-8"))


def scan_banks() -> list[dict]:
    out = []
    for p in sorted(BANKS_DIR.glob("*.json")):
        if p.name.startswith("_"):  # 跳过开考时生成的临时题库
            continue
        try:
            data = json.loads(p.read_text(encoding="utf-8"))
        except Exception:
            continue
        counts: dict[str, int] = {}
        for q in data.get("questions", []):
            counts[q["type"]] = counts.get(q["type"], 0) + 1
        out.append({
            "id": data.get("id", p.stem),
            "title": data.get("title", p.stem),
            "count": len(data.get("questions", [])),
            "types": counts,
            "total_score": sum(float(q.get("score", 0)) for q in data.get("questions", [])),
        })
    return out


# ---------------------------------------------------------------- 判分


def _answer_text(q: dict, picked: list[str], text: str) -> str:
    if q["type"] in OPTION_TYPES:
        return "、".join(picked)
    return str(text or "").strip()


def grade_item(q: dict, ans: dict) -> dict:
    picked = [k for k in ans.get("picked", []) if isinstance(k, str)]
    text = ans.get("text", "")
    unknown = bool(ans.get("unknown"))
    marks = [k for k in ans.get("marks", []) if k in {o["key"] for o in q["options"]}]

    correct: bool | None
    earned: float | None
    needs_review = False

    if unknown:
        correct, earned = False, 0.0
    elif q["type"] == "short":
        correct, earned, needs_review = None, None, True
    elif q["type"] in OPTION_TYPES:
        correct = set(picked) == set(q["answer"])
        earned = float(q["score"]) if correct else 0.0
    elif q["type"] == "fill":
        keys = {_squash(a) for a in q["answer"]}
        correct = _squash(text) in keys if text else False
        earned = float(q["score"]) if correct else 0.0
    else:
        correct, earned = False, 0.0

    return {
        "qid": q["id"],
        "type": q["type"],
        "type_label": TYPE_LABEL.get(q["type"], q["type"]),
        "stem": q["stem"],
        "options": q["options"],
        "answer": q["answer"],
        "answer_text": "、".join(q["answer"]) if q["type"] in OPTION_TYPES else " / ".join(q["answer"]),
        "picked": picked,
        "picked_text": _answer_text(q, picked, text),
        "marks": marks,
        "marks_text": "、".join(marks),
        "unknown": unknown,
        "correct": correct,
        "earned": earned,
        "score": float(q["score"]),
        "needs_review": needs_review,
        "explanation": q.get("explanation", ""),
        "seconds": int(ans.get("seconds", 0)),
    }


def build_result(sess: dict) -> dict:
    bank = load_bank(sess["bank"])
    items = [grade_item(q, sess["answers"].get(q["id"], {})) for q in bank["questions"]]
    auto_items = [i for i in items if not i["needs_review"]]
    weak = [
        {"no": n, "qid": i["qid"], "key": k, "stem": i["stem"], "picked": k in i["picked"]}
        for n, i in enumerate(items, start=1)
        for k in i["marks"]
    ]
    score = sum(i["earned"] or 0 for i in items)
    return {
        "session_id": sess["id"],
        "title": sess["title"],
        "submitted_at": sess["submitted_at"],
        "duration_seconds": int((sess["submitted_at"] or _now()) - sess["started"]),
        "score": round(score, 1),
        "auto_total": round(sum(i["score"] for i in auto_items), 1),
        "total": round(sum(i["score"] for i in items), 1),
        "correct": sum(1 for i in auto_items if i["correct"]),
        "wrong": sum(1 for i in auto_items if i["correct"] is False and not i["unknown"]),
        "unknown": sum(1 for i in items if i["unknown"]),
        "pending_review": [i["qid"] for i in items if i["needs_review"]],
        "marked_option_count": len(weak),
        "weak_options": weak,
        "items": items,
    }


# ---------------------------------------------------------------- 会话

SESSIONS: dict[str, dict] = {}
_LOCK = threading.RLock()


def _session_path(sid: str) -> Path:
    return DATA_DIR / f"{sid}.json"


def _persist(sess: dict) -> None:
    tmp = _session_path(sess["id"]).with_suffix(".tmp")
    tmp.write_text(json.dumps(sess, ensure_ascii=False), encoding="utf-8")
    os.replace(tmp, _session_path(sess["id"]))


def _get_session(sid: str) -> dict:
    with _LOCK:
        if sid in SESSIONS:
            return SESSIONS[sid]
        path = _session_path(_slug(sid))
        if not path.exists():
            raise ValueError(f"会话不存在：{sid}")
        sess = json.loads(path.read_text(encoding="utf-8"))
        SESSIONS[sess["id"]] = sess
        return sess


def _auto_submit_if_due(sess: dict) -> None:
    if sess["status"] == "running" and sess.get("minutes") and sess.get("deadline") and _now() >= sess["deadline"]:
        _submit(sess)


def _submit(sess: dict) -> dict:
    with _LOCK:
        if sess["status"] == "submitted":
            return sess["result"]
        sess["status"] = "submitted"
        sess["submitted_at"] = _now()
        sess["result"] = build_result(sess)
        _persist(sess)
        return sess["result"]


# ---------------------------------------------------------------- 用户配色（服务端持久化）

_THEME_HEX = re.compile(r"^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$")


def _clean_theme_state(raw) -> dict:
    """只保留合法字段，避免把任意 / 超大内容写进配置文件。"""
    out: dict = {}
    if not isinstance(raw, dict):
        return out
    if raw.get("base") in ("light", "dark"):
        out["base"] = raw["base"]
    for key in ("accent", "bg", "text"):
        v = raw.get(key)
        if isinstance(v, str) and _THEME_HEX.match(v.strip()):
            out[key] = v.strip()
    s = raw.get("strength")
    if isinstance(s, (int, float)) and not isinstance(s, bool):
        out["strength"] = max(0.0, min(1.0, float(s)))
    return out


def _theme_read() -> dict:
    with _LOCK:
        try:
            data = json.loads(THEME_FILE.read_text(encoding="utf-8"))
            if not isinstance(data, dict):
                raise ValueError
            return {"rev": int(data.get("rev") or 0),
                    "state": _clean_theme_state(data.get("state"))}
        except (OSError, ValueError, TypeError):
            return {"rev": 0, "state": {}}


def _theme_write(state) -> dict:
    with _LOCK:
        cur = _theme_read()  # RLock 可重入
        st = _clean_theme_state(state)
        payload = {"rev": cur["rev"] + 1, "state": st, "updated_at": _now()}
        THEME_FILE.parent.mkdir(parents=True, exist_ok=True)
        tmp = THEME_FILE.with_suffix(".tmp")
        tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        os.replace(tmp, THEME_FILE)
        return {"rev": payload["rev"], "state": st}


# ---------------------------------------------------------------- HTTP 服务

_httpd: ThreadingHTTPServer | None = None
_port: int = 0
_server_lock = threading.Lock()

# 绑定地址：默认 0.0.0.0，允许手机等局域网设备访问；
# 想只允许本机可设环境变量 EXAM_BIND=127.0.0.1。
BIND_HOST = os.environ.get("EXAM_BIND", "0.0.0.0")


def _lan_ips() -> list[str]:
    """本机可用的非回环 IPv4，供手机访问。检测失败时返回空列表。"""
    ips: list[str] = []
    try:
        for ip in socket.gethostbyname_ex(socket.gethostname())[2]:
            if not ip.startswith("127.") and ip not in ips:
                ips.append(ip)
    except OSError:
        pass
    try:  # 默认路由出口地址，优先排在前面
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        try:
            s.connect(("223.5.5.5", 80))
            ip = s.getsockname()[0]
            if ip and not ip.startswith("127."):
                ips = [ip] + [x for x in ips if x != ip]
        finally:
            s.close()
    except OSError:
        pass
    # 去掉 169.254 链路本地；192.168 家用/热点网段排前面，其余置后
    ips = [ip for ip in ips if not ip.startswith("169.254.")]
    ips.sort(key=lambda ip: 0 if ip.startswith("192.168.") else 1)
    return ips


def _lan_urls(sid: str) -> list[str]:
    """手机可用的完整地址（局域网 IP）。"""
    if BIND_HOST not in ("0.0.0.0", "::", ""):
        return []
    return [f"http://{ip}:{_port}/exam/{sid}" for ip in _lan_ips()]



class Handler(BaseHTTPRequestHandler):
    server_version = "exam-mcp"

    def log_message(self, *args):  # 静默，避免污染 stdio
        pass

    # -- helpers
    def _send(self, code: int, body: bytes, ctype: str) -> None:
        self.send_response(code)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        try:
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, obj, code: int = 200) -> None:
        self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), "application/json; charset=utf-8")

    def _text(self, text: str, code: int = 200, ctype: str = "text/plain; charset=utf-8") -> None:
        self._send(code, text.encode("utf-8"), ctype)

    def _body(self) -> dict:
        length = int(self.headers.get("Content-Length") or 0)
        if not length:
            return {}
        try:
            return json.loads(self.rfile.read(length).decode("utf-8"))
        except Exception:
            return {}

    # -- routes
    def do_GET(self):
        try:
            self._route_get()
        except Exception as exc:  # 任何异常都回 500，避免连接被直接掐断
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def do_POST(self):
        try:
            self._route_post()
        except Exception as exc:
            self._json({"error": f"{type(exc).__name__}: {exc}"}, 500)

    def _route_get(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if not parts:
            running = [s for s in SESSIONS.values() if s["status"] == "running"]
            if running:
                self.send_response(302)
                self.send_header("Location", f"/exam/{running[-1]['id']}")
                self.end_headers()
                return
            return self._text("exam-mcp 正在运行。用 start_exam 开考。")
        if parts[0] == "exam" and len(parts) == 2:
            return self._send(200, (STATIC_DIR / "exam.html").read_bytes(), "text/html; charset=utf-8")
        if parts[0] == "static" and len(parts) >= 2:
            target = (STATIC_DIR / "/".join(parts[1:])).resolve()
            # 防路径穿越：只允许 static/ 目录内的真实文件
            if not target.is_relative_to(STATIC_DIR.resolve()) or not target.is_file():
                return self._json({"error": "not found"}, 404)
            ctype = STATIC_TYPES.get(target.suffix.lower(), "application/octet-stream")
            return self._send(200, target.read_bytes(), ctype)
        if parts[0] == "api" and len(parts) >= 3:
            try:
                sess = _get_session(parts[2])
                _auto_submit_if_due(sess)
            except ValueError as exc:
                return self._json({"error": str(exc)}, 404)
            if parts[1] == "session" and len(parts) == 3:
                return self._json(session_payload(sess))
            if parts[1] == "session" and len(parts) == 4 and parts[3] == "result":
                if sess["status"] != "submitted":
                    return self._json({"error": "尚未交卷"}, 409)
                return self._json(sess["result"])
        if parts[0] == "api" and len(parts) == 2 and parts[1] == "theme":
            r = _theme_read()
            return self._json({"ok": True, "rev": r["rev"], "state": r["state"]})
        if parts[0] == "api" and len(parts) == 2 and parts[1] == "health":
            return self._json({"ok": True, "sessions": len(SESSIONS)})
        return self._json({"error": "not found", "path": self.path}, 404)

    def _route_post(self):
        parts = [p for p in urlparse(self.path).path.split("/") if p]
        if len(parts) == 2 and parts[0] == "api" and parts[1] == "theme":
            body = self._body()
            # 接受 {state: {...}} 或直接就是 state 对象；rev 由服务端维护，忽略客户端传值
            state = body.get("state", body) if isinstance(body, dict) else {}
            r = _theme_write(state)
            return self._json({"ok": True, "rev": r["rev"], "state": r["state"]})
        if parts[:2] != ["api", "session"] or len(parts) != 4:
            return self._json({"error": "not found"}, 404)
        try:
            sess = _get_session(parts[2])
        except ValueError as exc:
            return self._json({"error": str(exc)}, 404)

        action = parts[3]
        body = self._body()
        _auto_submit_if_due(sess)
        if action == "save":
            if sess["status"] == "running":
                with _LOCK:
                    sess["answers"] = body.get("answers", sess["answers"])
                    sess["current"] = body.get("current", sess.get("current", 0))
                    _persist(sess)
            return self._json({"ok": True, "status": sess["status"], "saved_at": _now()})
        if action == "submit":
            if sess["status"] == "running":
                with _LOCK:
                    sess["answers"] = body.get("answers", sess["answers"])
                _submit(sess)
            return self._json(sess["result"])
        return self._json({"error": "not found"}, 404)


def session_payload(sess: dict) -> dict:
    bank = load_bank(sess["bank"])
    timed = bool(sess.get("minutes"))
    remaining = max(0, int(sess["deadline"] - _now())) if timed else 0
    questions = [
        {
            "id": q["id"],
            "type": q["type"],
            "type_label": TYPE_LABEL.get(q["type"], q["type"]),
            "stem": q["stem"],
            "options": q["options"],
            "score": q["score"],
        }
        for q in bank["questions"]
    ]
    return {
        "id": sess["id"],
        "title": sess["title"],
        "status": sess["status"],
        "deadline": sess["deadline"],
        "remaining": remaining,
        "timed": timed,
        "elapsed": int(_now() - sess["started"]),
        "minutes": sess["minutes"],
        "questions": questions,
        "answers": sess["answers"],
        "current": sess.get("current", 0),
    }


def ensure_http(port: int = 0) -> str:
    global _httpd, _port
    with _server_lock:
        if _httpd is None:
            try:
                _httpd = ThreadingHTTPServer((BIND_HOST, port or 0), Handler)
            except OSError:  # 旧端口被占用时退回随机端口
                _httpd = ThreadingHTTPServer((BIND_HOST, 0), Handler)
            _httpd.daemon_threads = True
            _port = int(_httpd.server_address[1])
            threading.Thread(target=_httpd.serve_forever, daemon=True, name="exam-http").start()
    return f"http://127.0.0.1:{_port}"


# ---------------------------------------------------------------- 导出

EXPORT_HEAD = ["序号", "题干", "选项", "标准答案", "用户答案", "选项存疑", "不会做", "是否正确", "得分", "用时(秒)", "解析"]


def _options_text(options: list[dict]) -> str:
    return " ｜ ".join(f"{o['key']}. {o['text']}" if o["key"] not in {"对", "错"} else o["text"] for o in options)


def export_xlsx(result: dict, out_path: Path, only_wrong: bool = False) -> Path:
    wb = Workbook()
    ws = wb.active
    ws.title = "答题结果"
    ws.append(EXPORT_HEAD)
    head_fill = PatternFill("solid", fgColor="1F4E79")
    for cell in ws[1]:
        cell.font = Font(bold=True, color="FFFFFF")
        cell.fill = head_fill
        cell.alignment = Alignment(horizontal="center", vertical="center")

    for n, item in enumerate(result["items"], start=1):
        if only_wrong and item["correct"] is not False and not item["unknown"] and not item["marks"]:
            continue
        verdict = "—" if item["needs_review"] else ("√" if item["correct"] else "×")
        ws.append([
            n,
            item["stem"],
            _options_text(item["options"]),
            item["answer_text"],
            item["picked_text"],
            item["marks_text"],
            "是" if item["unknown"] else "",
            "待批" if item["needs_review"] else verdict,
            item["earned"] if item["earned"] is not None else "",
            item["seconds"],
            item["explanation"],
        ])

    widths = [6, 52, 38, 16, 16, 12, 8, 9, 7, 9, 42]
    for i, w in enumerate(widths, start=1):
        ws.column_dimensions[chr(64 + i)].width = w
    for row in ws.iter_rows(min_row=2):
        for cell in row:
            cell.alignment = Alignment(wrap_text=True, vertical="top")

    summary = wb.create_sheet("汇总")
    for key, label in [
        ("title", "题库"), ("submitted_at", "交卷时间"), ("duration_seconds", "用时(秒)"),
        ("score", "得分"), ("auto_total", "客观题满分"), ("total", "全卷满分"),
        ("correct", "答对"), ("wrong", "答错"), ("unknown", "不会做"),
        ("marked_option_count", "存疑选项数"),
    ]:
        value = result.get(key)
        if key == "submitted_at" and value:
            value = time.strftime("%Y-%m-%d %H:%M:%S", time.localtime(value))
        summary.append([label, value])
    if result["weak_options"]:
        summary.append([])
        summary.append(["存疑选项", "题号 / 选项 / 是否选了"])
        for w in result["weak_options"]:
            summary.append(["", f"第{w['no']}题 {w['key']} {'（已选）' if w['picked'] else '（未选）'}"])
    summary.column_dimensions["A"].width = 14
    summary.column_dimensions["B"].width = 60

    out_path.parent.mkdir(parents=True, exist_ok=True)
    wb.save(out_path)
    return out_path


# ---------------------------------------------------------------- MCP 工具

mcp = MCPServer(
    name="exam-mcp",
    instructions=(
        "本地题库考试服务。流程：list_banks → start_exam（把返回的网址给用户）→ "
        "wait_for_submit（等用户交卷）→ get_result（按错题与存疑选项讲评）。"
    ),
)


@mcp.tool()
def list_banks() -> str:
    """列出 banks/ 目录下已导入的题库（题量、题型、总分）。"""
    banks = scan_banks()
    if not banks:
        return "还没有题库。用 import_bank 导入 xlsx / csv 文件，或把文件放进 banks/ 后调用 import_bank。"
    return _dump(banks)


@mcp.tool()
def import_bank(path: str, bank_id: str = "") -> str:
    """导入题库。支持 xlsx / csv / json。

    xlsx 表头可用：题干、A~H（或“选项A”）、标准答案、解析、题型、分值；
    题型可写“单选题/多选题/判断题/填空题/简答题”，省略时按选项与答案自动推断。
    """
    src = Path(path).expanduser()
    if not src.is_absolute():
        src = (ROOT / path).resolve()
    if not src.exists():
        return f"文件不存在：{src}"
    bank = parse_bank(src, bank_id or _slug(src.stem))
    out = BANKS_DIR / f"{_slug(bank['id'])}.json"
    out.write_text(json.dumps(bank, ensure_ascii=False, indent=2), encoding="utf-8")
    counts: dict[str, int] = {}
    for q in bank["questions"]:
        counts[q["type"]] = counts.get(q["type"], 0) + 1
    return _dump({
        "ok": True,
        "bank_id": bank["id"],
        "title": bank["title"],
        "questions": len(bank["questions"]),
        "skipped": bank.get("skipped", 0),
        "types": {TYPE_LABEL.get(k, k): v for k, v in counts.items()},
        "total_score": sum(q["score"] for q in bank["questions"]),
        "file": str(out),
    })


@mcp.tool()
def start_exam(
    bank: str,
    minutes: int = 0,
    limit: int = 0,
    order: str = "original",
    open_browser: bool = True,
) -> str:
    """开一场考试，返回网页地址。

    bank: 题库 id 或 banks/ 下的文件名（如 “生理期中”）
    minutes: 限时分钟数，默认 0 表示不限时；>0 时到点自动交卷
    limit: 抽题数量，0 表示全部
    order: original 原顺序 / random 打乱
    """
    try:
        data = load_bank(bank)
    except ValueError as exc:
        return str(exc)

    questions = list(data["questions"])
    if order == "random":
        random.shuffle(questions)
    if limit and 0 < limit < len(questions):
        questions = questions[:limit]

    sid = uuid.uuid4().hex[:8]
    sub = dict(data)
    sub["id"] = f"_session_{sid}"
    sub["questions"] = questions
    (BANKS_DIR / f"_session_{sid}.json").write_text(json.dumps(sub, ensure_ascii=False), encoding="utf-8")

    now = _now()
    minutes = max(0, int(minutes))
    sess = {
        "id": sid,
        "bank": sub["id"],
        "title": data.get("title", data["id"]),
        "started": now,
        "deadline": now + minutes * 60 if minutes else 0,
        "minutes": minutes,
        "status": "running",
        "answers": {},
        "current": 0,
        "result": None,
        "submitted_at": None,
        "port": 0,
    }
    with _LOCK:
        SESSIONS[sid] = sess
        _persist(sess)

    base = ensure_http()
    with _LOCK:
        sess["port"] = _port
        _persist(sess)
    url = f"{base}/exam/{sid}"
    if open_browser:
        threading.Thread(target=lambda: webbrowser.open(url), daemon=True).start()
    return _dump({
        "session_id": sid,
        "url": url,
        "lan_urls": _lan_urls(sid),
        "title": sess["title"],
        "questions": len(questions),
        "total_score": sum(q["score"] for q in questions),
        "minutes": sess["minutes"],
        "timed": bool(sess["minutes"]),
        "note": "浏览器已打开就直接作答；没打开就把 url 发给用户。交卷后调用 get_result。",
    })


@mcp.tool()
def wait_for_submit(session_id: str, timeout_seconds: int = 900) -> str:
    """阻塞等待交卷，返回结果摘要；超时则返回进行中状态（可再次调用）。"""
    try:
        sess = _get_session(session_id)
    except ValueError as exc:
        return str(exc)
    deadline = _now() + max(1, timeout_seconds)
    while _now() < deadline:
        _auto_submit_if_due(sess)
        if sess["status"] == "submitted":
            return summary_text(sess["result"])
        time.sleep(1.0)
    _auto_submit_if_due(sess)
    if sess["status"] == "submitted":
        return summary_text(sess["result"])
    base = ensure_http(int(sess.get("port") or 0))
    return _dump({
        "status": "running",
        "session_id": session_id,
        "url": f"{base}/exam/{session_id}",
        "lan_urls": _lan_urls(session_id),
        "remaining_seconds": max(0, int(sess["deadline"] - _now())) if sess.get("minutes") else None,
        "answered": len([v for v in sess["answers"].values() if v.get("picked") or v.get("text") or v.get("unknown")]),
        "note": "用户还没交卷，可以稍后再调 wait_for_submit 或 get_result。",
    })


@mcp.tool()
def get_result(session_id: str, detail: bool = True) -> str:
    """取判分结果。detail=true 时返回逐题明细（含存疑选项与解析），false 只返回摘要与错题清单。"""
    try:
        sess = _get_session(session_id)
    except ValueError as exc:
        return str(exc)
    _auto_submit_if_due(sess)
    if sess["status"] != "submitted":
        base = ensure_http(int(sess.get("port") or 0))
        return _dump({"status": "running", "url": f"{base}/exam/{session_id}",
                      "lan_urls": _lan_urls(session_id), "note": "还没交卷"})
    result = sess["result"]
    if detail:
        return _dump(result)
    return summary_text(result)


def summary_text(result: dict) -> str:
    lines = [
        f"《{result['title']}》交卷完成",
        f"得分 {result['score']} / {result['auto_total']}（全卷 {result['total']}，主观题待批 {len(result['pending_review'])} 题）",
        f"答对 {result['correct']} 题，答错 {result['wrong']} 题，不会做 {result['unknown']} 题，"
        f"存疑选项 {result['marked_option_count']} 个，用时 {result['duration_seconds'] // 60} 分 {result['duration_seconds'] % 60} 秒",
        "",
        "错题与没把握的题：",
    ]
    for n, item in enumerate(result["items"], start=1):
        if item["correct"] is not False and not item["marks"] and not item["unknown"]:
            continue
        tag = "不会做" if item["unknown"] else ("答错" if item["correct"] is False else "存疑")
        lines.append(f"- 第{n}题 [{tag}] 你的答案：{item['picked_text'] or '空'}；正确答案：{item['answer_text']}"
                     + (f"；存疑选项：{item['marks_text']}" if item["marks_text"] else ""))
    if len(lines) == 5:
        lines.append("- 全对，没有错题。")
    return "\n".join(lines)


@mcp.tool()
def export_result(session_id: str, out_path: str = "", only_wrong: bool = False) -> str:
    """把结果导出为 xlsx：题干 / 选项 / 标准答案 / 用户答案 / 选项存疑 / 不会做 / 是否正确 / 解析。"""
    try:
        sess = _get_session(session_id)
    except ValueError as exc:
        return str(exc)
    _auto_submit_if_due(sess)
    if sess["status"] != "submitted":
        return "还没交卷，无法导出。"
    if out_path:
        target = Path(out_path).expanduser()
        if not target.is_absolute():
            target = (ROOT / out_path).resolve()
    else:
        target = ROOT / "data" / f"result_{session_id}.xlsx"
    path = export_xlsx(sess["result"], target, only_wrong=only_wrong)
    return _dump({"ok": True, "file": str(path)})


if __name__ == "__main__":
    mcp.run("stdio")

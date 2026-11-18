# KaoWo（考我）

> 本地题库考场：AI 通过 MCP 工具开考、等交卷、取判分，你在浏览器里像学习通一样做题。  
> 服务端零模型调用，只做抽题、判分、存档、导出。无账号、无监控、完全离线。

- **入口**：`server.py`（MCP stdio + 本地 HTTP，同一个进程）
- **工作区配置**：`E:/Claw/Learn/.mcp.json`，服务名 `exam`，工具前缀 `mcp__exam__`
- **数据**：题库 `banks/`，作答快照 `data/sessions/`，导出 `data/result_*.xlsx`，用户配色 `data/theme-user.json`

> 项目名已定为 **KaoWo（考我）**；本地目录仍叫 `exam-mcp`、MCP 服务名仍是 `exam`，以保持现有配置与流程完全不变。

## 一次完整流程

```python
list_banks()                        # 看有哪些题库
import_bank("banks/生理期中.xlsx")   # 导入（也可先手动放进 banks/）
start_exam("生理期中")               # 开考，默认不限时，浏览器自动打开
  → 把返回的 url 给用户，用户在网页作答、交卷
wait_for_submit(session_id, 900)    # 阻塞等交卷（可跳过，直接等用户说交了）
get_result(session_id)              # 取逐题明细：错题、不会做、存疑选项、解析
export_result(session_id)           # 导出 xlsx
```

`start_exam` 参数：`minutes=0` 不限时（默认）；`>0` 到点自动交卷。`limit` 抽题数量，`order="random"` 打乱。

## 题库表格格式

第一行表头，列顺序随意，按名字匹配。**题干**和**标准答案**必需。

| 列 | 写法 |
|---|---|
| 题干 | `题干` / `题目` / `问题` |
| 选项 | `A`…`H`，或 `选项A`…`选项H`；也可只给一列 `选项`，写成 `A. 甲 ｜ B. 乙` |
| 标准答案 | `标准答案` / `正确答案` / `答案` |
| 可选列 | `解析`、`题型`、`分值` |

题型写 `单选题 / 多选题 / 判断题 / 填空题 / 简答题`；不写则按"有无选项 + 答案字母个数"推断。

答案写法：

- 单选 `B`；多选 `ABD`、`A、B、D`、`A,B,D` 都行
- 判断 `对/错`、`正确/错误`、`√/×`、`T/F`
- 填空一个空，多个可接受答案用 `|` 分隔：`白蛋白|清蛋白`
- 简答写参考答案，交卷后标为"待批改"，不自动判分
- 分值列留空时：单选/判断 1 分，多选/填空 2 分，简答 5 分

导入支持 `.xlsx` `.xlsm` `.csv` `.tsv` `.json`。CSV 编码自动试 UTF-8 / GB18030。

## LaTeX 公式

题干、选项、解析里可以写 LaTeX，用 `$...$`（行内）或 `$$...$$`（独立成行）包起来，也认 `\(...\)`、`\[...\]`。  
渲染用本地 KaTeX（`static/katex/`，含 20 个 woff2 字体），**完全离线**，不访问任何 CDN / API，亮暗主题都跟随文字色。

| 想显示 | 题库里写 |
|---|---|
| 米氏方程 | `$v=\frac{V_{max}[S]}{K_{m}+[S]}$` |
| 下标 / 上标 | `$K_m$`、`$[S]^2$` |
| 希腊字母 | `$\alpha$`、`$\Delta G$` |

- 判分比对的是原始字符串，公式不参与判分（答案仍是 `C` 这类字母），`$...$` 不影响对错。
- 公式语法坏了或没写 `$`，页面**保留原文不报错**（`throwOnError: false`），不会让整题崩；给某段文字加 `class="no-math"` 可跳过渲染。
- 静态资源走 `/static/<任意子路径>` 路由（带路径穿越防护），新增文件直接丢进 `static/` 即可。
- ⚠️ **从 PDF / OCR / Word 转题库时最容易踩的坑**：`\frac` 的反斜杠、`{}` 分组、`$` 定界符被剥掉，变成 `v=fracVmax[S]Km+[S]` 这种既不是合法 LaTeX、也读不通的乱码，任何渲染器都救不回来。导入前确认公式是 `$...$` 包住且 `\`、`{}` 都在。要订正就改**源 xlsx** 再重新 `import_bank`，不要手改 `banks/*.json`（会被覆盖）。

## 页面交互

- 每个选项右侧有一个虚线 `?`，点一下把它标成"没掌握"。标记与是否选中完全独立：可以选了标、也可以没选就标，一行可以标多个。标记只改变问号本身（变橙色实心），不改选项底色。
- 底部右侧 `不会做`：本题按 0 分计，自动跳到下一题。**不清空已选选项和已写文字**，最后一题不跳转，再点一次可取消。
- 右侧答题卡：蓝=已答，橙=不会做，右上角橙点=有存疑选项，蓝框=当前题，点格子跳转。
- 键盘：`1`–`8` 选项、`←`/`→` 翻页、`U` 不会做。
- 交卷：弹窗显示已答/未答/存疑数，确认后进结果页。结果页有得分环、按"错题 / 有存疑 / 不会做 / 待批改"筛选，顶部单独列出所有存疑选项。
- 不限时模式页头显示"不限时"；限时才显示倒计时，最后 5 分钟变红。

答案实时保存（防抖 700ms，不会做立即保存），服务端 + localStorage 双备份，刷新可继续。

## 主题配色

顶栏（手机端在题号抽屉顶部）点「配色」打开调色盘。**高度自定义**：轮廓、背景、字体三处可分别指定不同颜色，
主题色还会按「染色强度」大量铺到背景上，不只是改选中框那点轮廓。

**配置分两份，都不在题库里、不碰 `data/sessions/` 作答数据**：

| 文件 | 作用 | 进 git |
|---|---|---|
| `static/theme.json` | 出厂默认：预设色板 / 最小对比度 `contrast` / 默认染色强度 `strength` | 是（共享模板，可手改） |
| `data/theme-user.json` | 你实际选的配色（`base` / `accent` / `bg` / `text` / `strength`）+ 版本号 `rev` | 否（`data/` 已被 `.gitignore` 排除） |

**跨浏览器 / 端口 / 访问地址同步**：用户配色由服务端经 `/api/theme`（GET 读 / POST 写）持久化到
`data/theme-user.json`。页面用的是相对路径 `/api/theme`，所以无论从 `127.0.0.1`、`localhost` 还是
局域网 IP 访问，无论哪个端口、换哪个浏览器，读写的都是**同一份文件**：

- 启动即 GET 服务端配置并覆盖本地显示；
- 每次改动防抖（350ms）POST 推送，服务端做字段校验与原子写；
- 定时（3s）与切回页面时轮询，按 `rev` 跟随其他浏览器 / 标签页的改动（本地有未推送改动时本地优先）；
- `localStorage` 只留 `exam-ui:palette` / `exam-ui:theme` 两个键（与作答缓存 `exam:<sid>` 隔离），
  降级为「首帧防闪 + 服务端不可用时的离线缓存」，**不再是权威源**。

调色盘分三块，每块都有取色器 + hex 输入 + 「应用」+ `↺` 清除：

- **主题色 · 轮廓 / 选中框 / 按钮**：12 个预设色 + 自定义取色。决定 `--blue` 主色系（选中框、按钮、
  得分环、当前题描边）与边框线 `--line*`。保持色相 / 饱和度，只沿明度方向调整，直到主色与卡片背景达到
  `theme.json` 的 `contrast`（默认 4.5:1，WCAG AA 正文）；浅色压暗、暗色提亮，再由主色派生
  `--blue-dark` / `--blue-soft` / `--blue-grad` / `--blue-hover` / `--blue-cell-border`、聚焦光环、
  答题卡图例等整套色阶。
- **背景 · 主题色大量应用**：`染色强度` 滑块（0–100%，默认取 `theme.json` 的 `strength`=0.38）控制主题色
  铺到 `--bg` / `--surface` / `--surface-2/3` / `--hover-bg` 和边框的比例，越大背景越「有色」；
  也可「单独指定」一个背景色直接覆盖。**强度拉到 0** 即让背景与边框回到中性。
- **字体色**：可单独指定 `--ink*`；不指定时，若新背景让默认文字对比不足，会按最小对比度自动取纯黑或纯白。
  面板实时显示「字体 vs 卡片」对比度是否达标，并有「按最小对比度自动修正字体」一键修正。

规则与边界：

- **功能色不变**：红 / 黄 / 绿对错色、`--on-color` / `--on-amber` 始终不动。
- **默认零改动**：没自定义任何颜色时不写内联变量，页面与原来的明暗主题像素级一致。
- **复原**：只想褪掉背景染色 → 强度拉到 0；要连轮廓、字体一起复原 → 点「清除自定义」（`clearAll()`）。
  面板底部「☀ 浅色 / ☾ 深色」是原明暗切换，点任一个即切基底并清除全部自定义、回到该主题干净预设；
  用处不大所以缩成小按钮，紧挨「清除自定义」「完成」并排。
- **明暗统一由 `theme.js` 管理**：`app.js` 只剩「配色」按钮，独立的明暗按钮与 `toggleTheme` 已移除；
  `data-theme` 由本模块设置并监听，离线也能用。
- **配置文件**：两份都不进题库、不碰 `data/sessions/`。`static/theme.json`（进 git，出厂默认）含
  `defaultAccent` / `contrast` / `strength` / `presets`，可手改后刷新生效，读取失败时用 `theme.js`
  内置兜底；`data/theme-user.json`（不进 git）由 `/api/theme` 自动维护，删掉即回到出厂默认。
  静态资源走 `/static/` 路由，新增文件直接丢进 `static/` 即可，无需改后端。

主题色逻辑全在 `static/theme.js`（对外 `window.KaoWoTheme`，另含 `syncNow()` / `getState()`），
服务端读写在 `server.py` 的 `/api/theme` 与 `_theme_read` / `_theme_write`。作答、判分、保存、题库读取逻辑均未改动。

## 判分规则

| 题型 | 规则 |
|---|---|
| 单选 / 判断 | 选中集合与答案完全一致 |
| 多选 | 必须完全一致，没有部分分 |
| 填空 | 去空白、去中英文标点、忽略大小写后，命中任一备选答案 |
| 简答 | 不判分，`needs_review=true`，留给 AI 批改 |
| 不会做 | 一律 0 分，并在结果里单独标记（哪怕写了答案） |

## 导出表格

`序号｜题干｜选项｜标准答案｜用户答案｜选项存疑｜不会做｜是否正确｜得分｜用时(秒)｜解析`  
另有「汇总」sheet：得分、答对/答错/不会做、存疑选项清单。`only_wrong=True` 只导错题、存疑、不会做的题。

导出的表可以改完再导入（`选项` 列能被反向解析），做错题重练。

## 目录结构

```
exam-mcp/                ← 本地目录名；开源仓库名 KaoWo
├─ server.py            MCP 工具 + HTTP 服务 + 判分 + Excel 读写
├─ static/exam.html     页面外壳（引入 KaTeX 与 theme.js）
├─ static/style.css     样式（明暗 + 主题色变量）
├─ static/app.js        答题逻辑（改交互从这里下手）
├─ static/theme.json    出厂默认配色：预设色板 / 最小对比度 / 染色强度（进 git，可手改）
├─ static/theme.js      主题色计算 + 调色盘 + 服务端同步（独立模块，不碰作答逻辑）
├─ static/katex/        本地 KaTeX：css / js / auto-render / fonts（离线，勿删）
├─ banks/*.xlsx|json    题库；导入生成同名 .json
├─ banks/_session_*.json 开考时抽题快照（可随时删，勿当题库）
├─ data/sessions/*.json 每场作答与结果
├─ data/result_*.xlsx   导出的成绩表
└─ data/theme-user.json 用户配色（服务端持久化，跨浏览器/端口共享，不进 git）
```

## 环境与排障

依赖只有 `mcp>=2.3` 和 `openpyxl`，已装在 `.venv`：

```bash
cd E:/Claw/Learn/exam-mcp
.venv/Scripts/python.exe -m pip install -r requirements.txt
```

- **`/mcp` 显示 Failed to reconnect**：确认 `.mcp.json` 里 `command` 指向的 `.venv/Scripts/python.exe` 存在、`args` 指向的 `server.py` 存在；手动跑 `.venv/Scripts/python.exe server.py` 应该什么都不输出并挂住（stdio 服务，正常）。
- **改了代码不生效**：MCP 服务是会话启动时拉起的常驻进程，改完要重启会话（或 `/mcp` 重连）。
- **页面打不开**：服务随会话存活，会话结束端口就没了；`data/sessions/` 里的记录还在，下次开新会话时用同一端口能继续访问旧会话（`ensure_http` 会优先复用记录的端口）。
- **端口被占**：会自动退回随机端口，但已经打开的旧标签页仍指向旧端口，需要换新链接。
- **换浏览器 / 换端口配色没跟上**：配色存在服务端，页面加载即拉取、每 3 秒轮询；切到别的窗口再切回会立即同步。手动删掉 `data/theme-user.json` 后所有端回到出厂默认。
- **手机打不开（同一热点/局域网）**：先看 `netstat -ano | findstr <端口>` 是否显示 `0.0.0.0:<端口>`；若只有 `127.0.0.1:<端口>`，说明服务只绑了回环地址（旧版本行为），用 `start_exam` 返回的 `lan_urls` 里的 `http://<局域网IP>:<端口>/exam/<id>` 访问。仍不通再查 Windows 防火墙是否放行该 python.exe 的入站。
- **不要往 stdout 打印**：stdio 协议走 stdout，任何 `print` 都会破坏握手；调试写文件或 stderr。

## 已知限制

- 题干不支持插图（加图片题需要：导入时把图片复制到 `banks/media/`，页面用 `<img>` 渲染，约 30 行）
- 多选无部分分；简答不自动判分
- 单人单机使用，没有账号、防作弊、监控，也不打算加
- 每次开考会在 `banks/` 留一个 `_session_*.json` 快照，定期清理即可

## 改代码的入口

| 想改什么 | 改哪里 |
|---|---|
| 明暗配色、间距 | `static/style.css` 顶部 CSS 变量 |
| 主题色板 / 最小对比度 / 默认染色强度 | `static/theme.json`；三槽计算、调色盘、明暗切换与跨端同步都在 `static/theme.js` |
| 用户配色存哪 / 读写接口 | `server.py` 的 `THEME_FILE`（默认 `data/theme-user.json`）与 `/api/theme`（GET/POST） |
| 按钮、键盘、跳题逻辑 | `static/app.js` 的 `renderQuestion` / `onPanelClick` / `toggleUnknown` |
| 判分规则、部分分 | `server.py` 的 `grade_item` |
| 新增题型 | `server.py` 的 `TYPE_LABEL`、`grade_item`、`_guess_type`；`app.js` 的 `renderQuestion` |
| 导出列 | `server.py` 的 `EXPORT_HEAD` 与 `export_xlsx` |
| 端口、绑定地址 | `server.py` 的 `ensure_http` 与 `BIND_HOST`（默认 `0.0.0.0`，允许手机等局域网设备访问；设环境变量 `EXAM_BIND=127.0.0.1` 可恢复仅本机） |
| 公式定界符 / 渲染行为 | `static/app.js` 的 `MATH_DELIMS`、`renderMath` |
| 静态资源 MIME / 放行目录 | `server.py` 的 `STATIC_TYPES`、`_route_get` 的 `/static/` 分支 |

## 许可证

本项目仅供个人学习使用，请遵守相关法律法规。
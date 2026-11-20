# 研发交付说明 · 三大运营商个人卡话费余额监控

## 1. 变更摘要

- 关联 PRD ID：无（用户对话需求：查三大运营商电话卡余额并纳入监控）
- 主要改动模块：
  - `src/services/scraper_wallets.mjs`：新增运营商规则表 `CARRIER_RULES`、网厅入口 `CARRIER_ENTRY_URLS`；规则解析支持候选关键字组 `keywords` 与菜单入口 `entries`；抓取流程支持"首页没余额就点菜单进入子页"；关键字支持数组匹配。
  - `src/services/balance.js`：新增 `carrier_cmcc` / `carrier_ct` / `carrier_cu` 三个查询器与共享函数 `scrapeCarrier()`。
  - `public/index.html`：新增三个运营商 provider 选项、图标、快速添加模板；登录按钮与"全部一键登录"按钮对运营商生效。
  - `scripts/wallet-login.mjs`：登录目标纳入 `provider LIKE 'carrier_%'` 的平台；登录检测关键字支持数组。
  - `scripts/setup-carrier-platforms.mjs`：新增，一次性把三家运营商写入数据库。
  - `scripts/test-carrier-balance.mjs`：新增，解析逻辑单元测试（41 项，含真实移动页面正文回归）。

## 2. 调研结论：官方接口到底有没有

这是本次调研的核心问题，结论需要分两层说清楚。

### 2.1 官方接口：存在，但个人拿不到

三家运营商**都**提供官方余额查询接口，位置在各自的能力开放平台，不是没有。但这些接口的获取条件对企业资质有硬性要求：

| 运营商 | 官方接口所在 | 接口 | 余额字段 | 申请条件 |
|---|---|---|---|---|
| 中国移动 | 中国移动 IT 能力开放平台 `it.open.10086.cn` | 「查账户余额」「话费余额鉴权」「查账单」 | 平台文档未在公开页展示字段名 | 企业账号 + 实名认证 + 场景审核，且需用户短信授权码 |
| 中国电信 | 天翼开放平台 `open.e.189.cn` | `POST /api/oauth2/account/queryCTPackage.do` | `totalBalanceAvailable`（单位：**分**） | 企业开发者入驻 + 能力商店申请 + 能力签约 |
| 中国联通 | A-PaaS 能力开放平台 | 「账户余额查询」（API 规范 v1.8 §5.3）、「当月话费查询」§5.6、「欠费查询」§5.4 | 字段名随规范版本 | 企业资质 + 能力申请审核 |
结论：**个人开发者无法自助申请这些接口**。三条硬性门槛——企业实名认证、能力商店申请与资质审核、用户侧逐次短信授权（移动的「用户授权码申请接口」需要用户回短信验证码）。第三点尤其关键：即使拿到接口权限，查询某个用户的话费余额仍需该用户每次授权，这不是能用于后台定时巡检的形态。

因此本项目对个人卡走**网上营业厅页面抓取**，这是个人唯一能拿到程序化数据的路径。

### 2.2 抓取路径的可行性与代价

三家网厅的个人查余额入口（**2026-11-20 实测**）：

| 运营商 | 实测入口 | 实测现象 |
|---|---|---|
| 中国移动 | `https://shop.10086.cn/i/?f=home` | 正常渲染。未登录时跳转 `login.10086.cn/login.html?channelID=12003`，支持扫码登录与短信随机码；首页「服务专区」另有「账单查询」「余量查询」「充话费」直达链接。**已登录实测**：个人中心页显示「我的账户 70.90元交费> 可用余额： 70.90元账单> 账户总余额 ： 0.00元详单>」 |
| 中国电信 | `https://www.189.cn/` | **无头浏览器与桌面浏览器下正文均为 0 字、链接数为 0**，属站点级反爬拦截；`gd.189.cn`、`/service/index.html` 同样为空，`my.189.cn` 连接超时 |
| 中国联通 | `https://www.10010.com/` | 正常渲染（hash 路由 SPA）。首页无余额链接，余额入口在 hover 展开的「查询」二级菜单；页面另有一个 `upay.10010.com/upayWeb/phoneSpeedy` 交费 iframe |

抓取方案的两点现实约束：

1. **省际差异**：网厅是分省部署的，菜单文案与路径在各省不完全一致，所以规则里配了候选关键字组和多个菜单入口文字，按顺序尝试。移动已实测到精确入口，电信与联通仍需实际登录后核对。
2. **电信的反爬是硬约束**：实测无头环境下拿不到任何页面内容，因此电信的抓取**必须依赖桌面 Chrome**（`scripts/start-chrome-debug.cmd` 启动的 CDP 模式，真实浏览器指纹与登录态）。代码已为此加了退路：无头抓取失败时自动改用桌面 Chrome 重试（`allowCdpFallback`），无头上下文也补上了真实 Chrome UA、中文区域与时区。若两者都不可用，电信需退回手动录入。
3. **登录态是前提**：三家都要服务密码或短信验证码，我无法代办，必须由你本人完成一次登录。登录态存在 `src/wallet-states/storage_carrier_*.json`（已在 `.gitignore` 中，不入库）。

### 2.3 被排除的路径

| 路径 | 为什么不做 |
|---|---|
| 短信指令自动化（发 10086 查余额） | 10086 的回复短信只发回持卡手机。第三方短信通道（阿里云/腾讯云/创蓝等）只能下发、收不到运营商回信。要自动解析回复必须上短信转发硬件或安卓自动化设备，投入产出不划算。 |
| 物联网卡厂商 API | 能力确定存在（移动 OneNET、电信 CTW、联通物联网平台），但需要企业资质且卡必须是物联网卡。你的是普通个人实体卡，不适用。 |
| 渠道商商务接口 | 运营商把「话费充值 + 余额查询」打包给渠道商，需商务签约与单独采购，个人拿不到。 |

## 3. 运行与验证

```bash
# 1) 把三家运营商加入数据库（可选，页面「快速添加」也能加）
node scripts/setup-carrier-platforms.mjs

# 2) 首次登录网厅（需要你本人输入服务密码/短信验证码，弹窗交互）
node scripts/wallet-login.mjs carrier_cmcc   # 中国移动
node scripts/wallet-login.mjs carrier_ct     # 中国电信
node scripts/wallet-login.mjs carrier_cu     # 中国联通
# 或一次跑完：node scripts/wallet-login.mjs

# 3) 无头验证抓取结果
node scripts/wallet-check.mjs                  # 全部抓取型平台（含三家运营商）
node scripts/wallet-check.mjs carrier_cmcc      # 只验一家

# 4) 测试
npm test                                  # 端到端冒烟（37 项）
node scripts/test-carrier-balance.mjs     # 运营商解析单元测试（41 项）

# 5) 本地启动
npm run dev
```

实测结果（2026-11-20 最新）：

- `npm test` → 37 项全部通过，exit 0（含 6 项运营商端到端用例：登录态检测、未登录时刷新返回结构化失败、错误提示指向登录脚本、抓取失败不生成充值单、不写入余额历史）
- `node scripts/test-carrier-balance.mjs` → 56 项全部通过，exit 0
- **中国移动真实抓取已联调通过**：
  - 登录：`node scripts/wallet-login.mjs carrier_cmcc` → 短信随机码登录 → 登录态保存到 `src/wallet-states/storage_carrier_cmcc.json`
  - 抓取：`node scripts/wallet-check.mjs 中国移动话费` → `OK 中国移动话费 : 70.9`
  - 与网厅页面显示的「可用余额： 70.90元」一致
  - 注意：移动登录态有效期较短（实测约 30 分钟内有效），过期后需重新登录；过期表现是跳转到 `login.10086.cn`
- **中国电信真实抓取已联调通过**：
  - 登录：`node scripts/wallet-login.mjs carrier_ct` → 登录态保存到 `src/wallet-states/storage_carrier_ct.json`
  - 抓取：`node scripts/wallet-check.mjs 中国电信话费` → `OK 中国电信话费 : 54.61`
  - 与网厅首页显示的「账户余额 54.61元」一致
  - 该站需有头窗口抓取（见 §3.3），巡检时会短暂弹出 Chrome 窗口
- **服务巡检全链路已验证**：重启加载新代码后，巡检日志 `[monitor 15:00:51] 刷新 3 平台, 生成 0 充值单, 到账 0, 错误 0`，三家余额全部落库（DeepSeek 9.11 / 中国移动话费 70.9 / 中国电信话费 54.61），`latest_error` 均为 null
- 中国联通**仍未联调**：需你本人完成一次网厅登录（`node scripts/wallet-login.mjs carrier_cu`）

### 3.1 两个必须知道的运维约束

**服务要用新代码必须重启。** 服务由 `启动项.bat` 以 `node src/server.js` 启动（无 watch），改了代码不会热重载。运营商查询器是新加的，旧进程里没有，刷新会按通用 API 去请求网厅首页拿到 HTML，报 `Unexpected token '<'`。

**写数据库要走服务，不能直接改文件。** 服务用 sql.js，数据库整个读进内存、每次写操作把全库覆盖写回文件。因此「服务运行中」时直接改 `src/data/llm-manager.db` 会被服务的下一次落盘抹掉（本次就因此丢过电信、联通两条记录）。`scripts/setup-carrier-platforms.mjs` 已改为自动判断：服务在跑就走 HTTP API 写入，服务没跑才直接改文件。

```bash
node scripts/setup-carrier-platforms.mjs            # 三家
node scripts/setup-carrier-platforms.mjs --only cmcc # 只加一家
```

### 3.2 浏览器可执行文件的定位

Playwright 的 `chromium.executablePath()` 依赖 `PLAYWRIGHT_BROWSERS_PATH` 环境变量。登录脚本与巡检服务是两个进程，环境不同：服务由 `启动项.bat` 拉起时不继承该变量，会指向默认 `ms-playwright` 目录——那里通常没装浏览器，报 `Executable doesn't exist`。

代码已改为 `resolveBrowserExecutable()`：按「Playwright 自带 chromium → `PLAYWRIGHT_BROWSERS_PATH` 下的 `chromium-*/chrome-win64/chrome.exe` → 系统安装的 Chrome/Edge」逐个探测**实际存在的文件**，用绝对路径启动，不再依赖环境变量。

### 3.3 189.cn 打不开：两层拦截

**现象**：在自动化浏览器里打开 `https://www.189.cn/`，页面一片空白，正文长度为 0；同一个网址在日常浏览器里正常打开。

这是**两层独立的拦截**，必须都绕过才行。

**第一层：反自动化标记**

| 启动方式 | 结果 |
|---|---|
| 系统 Chrome + 原有启动参数 | 正文 0 字，html 仅 39 字符 |
| 系统 Chrome + 不带任何参数 | 正文 0 字，html 仅 39 字符 |
| 系统 Chrome + `--disable-blink-features=AutomationControlled` | 正文 1186 字，跳转到 `/web/`，出现「账户余额」等业务文案 |

Playwright 默认把 `navigator.webdriver` 置为 `true`，189.cn 据此判定为自动化客户端。修复：`BROWSER_ARGS` 增加 `--disable-blink-features=AutomationControlled`。

**第二层：站点级拦无头浏览器**

第一层修好后，有头模式能打开，**无头模式仍然返回空页面**：

| 模式（均已带登录态） | 结果 |
|---|---|
| 无头 + 拦截图片字体 | 正文 0 字 |
| 无头 + 不拦截图片字体 | 正文 0 字 |
| **有头** | 正文 1257 字，可见「黄** / 190****3361 / 退出登录 / 账户余额」 |

与是否拦截静态资源无关，纯粹由无头模式决定。修复：电信内置规则标记 `headlessBlocked: true`，抓取时改用有头窗口（窗口短暂弹出，抓完自动关闭）。`scrapeWithStorage` 支持 `headless` 参数，`scrapeWalletBalance` 与 `scrapeWalletsBatch` 按该标记分流，避免先无头失败再回退、白等一轮超时。

### 3.4 运营商登录判定：不能只看标签是否出现

189.cn **未登录**的首页文本里就有「账户余额」，只是值为占位符 `--`：

```
中国电信欢迎你 登录 手机 宽带 固话 -- 账户余额 -- 已用通用流量 -- 剩余积分 充值…
```

若登录检测只看「标签是否出现」，会把未登录页面误判成已登录，导出一份无效登录态——表面登录成功，后续巡检却永远抓不到余额。

现用 `detectCarrierLoggedIn()`，满足任一条才算已登录：

1. 页面出现登录后专属文案「退出登录 / 退出」（未登录态实测出现次数为 0）；
2. 余额标签后紧跟真实数字（占位符 `--` 不算；标签与数字之间夹了其他中文标签也不算）。

### 3.5 电信首页是「数值在上、标签在下」

移动网厅是「可用余额： 70.90元」（标签在前），电信网厅相反——金额出现在标签**之前**：

```
…手机 宽带 固话 54 .61 元 账户余额 0 .00 KB 已用专用流量 0 分钟 已用通用语音 0…
```

而且金额被拆成两段渲染（`54` + 换行 + `.61`）。两个后果：

- 沿用「标签后取数」会取不到，或取到下一个栏目（`已用专用流量 0.00KB`）的数值；
- 不做归一化，`54.61` 会被读成 `54`。

修复：内置规则新增 `valueBeforeLabel` 标记，提取时**先**从标签位置往前找紧邻金额，**找不到再**走原来的「标签后跟金额」（兼容其他省份版本的相反布局）；`extractBalance` 先把跨行拆分的小数接回。

相关回归用例在 `scripts/test-carrier-balance.mjs`（60 项）。

## 3.6 登录态能保持多久，以及怎么让它活得久些

### 实测：两家都是「滑动续期」会话

读取登录态文件里的 cookie 过期时间（2026-11-20 实测），并做对照实验（访问一次网厅后对比 cookie 过期时间的变化）：

| 运营商 | 关键 cookie | 登录后过期 | 访问一次后 | 续期窗口 |
|---|---|---|---|---|
| 移动 | `chargeresource` | 登录后 30 分钟 | 推到「访问时刻 + 30 分钟」 | **30 分钟** |
| 移动 | `rdmdmd5` | 30 分钟左右 | 不再下发 | 30 分钟 |
| 电信 | `yiUIIlbdQT3fT` | +7 天 | 推到「访问时刻 + 7 天」 | **7 天** |
| 电信 | `yiUIIlbdQT3fS` | +1 年 | 推到「访问时刻 + 1 年」 | 1 年 |

结论：网厅会话不是固定时长，而是**每次访问都把过期时间往后推**（滑动续期）。只要在窗口内再访问一次，会话就能一直续下去。

### 原来为什么会掉

两个原因叠加：

1. **抓取后从不写回 cookie。** `scrapeWithStorage` 加载 `storageState`、抓完就关浏览器，服务端刷新过的 cookie 全被丢弃。等于每次巡检都在用「登录那一刻」的过期时间重新算起，窗口一过必然失效。实测：14:04 存的移动登录态，15:02 抓取就跳了 `login.10086.cn`。
2. **巡检周期比滑动窗口长。** 默认巡检 1 小时，而移动窗口只有 30 分钟——即使写回了，两次巡检之间也会空掉。

### 采取的措施

**（1）抓取成功后写回续期后的 cookie**（`persistStorageState`）

`src/services/scraper_wallets.mjs` 新增该函数：抓取成功（或保活访问）后把浏览器上下文当前的 cookie 原子写回登录态文件（先写 `.tmp` 再 rename，并保留一份 `.bak`）。单平台路径与批量路径都已接入。

实测验证：抓取一次后 `chargeresource` 过期时间从 `15:29:03` 推到 `15:43:03`，正好是「访问时刻 + 30 分钟」。

**（2）给运营商加一条更快的保活节奏**（`startCarrierKeepAlive`）

`src/services/monitor.js` 新增保活器，与巡检并行运行：

- 每分钟检查一次，到期才访问网厅；
- 间隔取自 `CARRIER_KEEPALIVE_MS`：移动 10 分钟、电信 1 小时、联通 30 分钟（联通未联调，先取保守值）；
- 保活只做「访问 + 写回 cookie」，**不提取余额、不写余额历史、不触发充值单**——否则每 10 分钟写一条历史会污染数据并让阈值判断频繁触发；
- 会话已失效时（跳转登录页）主动推送手机提醒，比等 1 小时后的巡检报错更早，同一平台 6 小时内只推一次。

保活访问的是网厅入口页即可，不需要点菜单进余额子页。

**（3）不能靠纯 HTTP 续期**

实测用 `fetch` 带 cookie 直接 GET 网厅：移动返回 200 但 **Set-Cookie 条数为 0**（不触发续期）；电信返回 412（被拦截）。所以续期必须走真实浏览器，保活开销无法避免。

### 仍然需要重新登录的情况

| 情况 | 表现 |
|---|---|
| 运营商强制下线（如异地登录、长时间未活动） | 服务端直接失效，续期也救不回来，需重新登录 |
| 移动短信登录的随机码会话本身有服务端上限 | 长时间不访问仍可能被回收 |
| cookie 文件被删或损坏 | 保活会跳过（没有登录态文件），巡检报错并提示重新登录 |

登录态文件在 `src/wallet-states/`，已确认在 `.gitignore` 内（含新生成的 `.bak`），凭据不会进版本库。

## 4. 配置与环境变量

| 变量 | 必填 | 说明（不含秘密） |
|---|---|---|
| LLM_MANAGER_PORT | 否 | 服务端口，默认见 `scripts/port.mjs` |
| LLM_MANAGER_DATA_DIR | 否 | 数据库目录，默认 `src/data/` |
| LLM_MANAGER_WALLET_STATE_DIR | 否 | 登录态文件目录，默认 `src/wallet-states/`。测试用它指向临时目录，避免开发机真实登录态影响断言 |

平台级配置（在页面「编辑」里改）：

| 字段 | 说明 |
|---|---|
| `provider` | `carrier_cmcc` / `carrier_ct` / `carrier_cu` |
| `balance_api_url` | 网厅入口 URL，默认取 `CARRIER_ENTRY_URLS`，可按你所在省份改成具体网厅地址 |
| `balance_json_path` | 提取规则，留空即用内置规则；可写 JSON 覆盖 `keyword` / `keywords` / `regex` / `entries` / `max` |
| `currency` | 固定 `CNY` |
| `threshold` | 默认 20 元（话费余额远低于 API 余额，建议阈值调小） |
| `recharge_amount` | 默认 100 元 |

**登录凭据（服务密码、短信验证码）不写入数据库、不写入代码库、不写入本文件。** 它们只在登录弹窗里当场输入，产物是 `src/wallet-states/storage_carrier_*.json`（已被 `.gitignore` 排除）。

## 5. 数据库/迁移

无 schema 变更。`platforms` 表已有 `provider` / `balance_type` / `balance_api_url` / `balance_json_path` 字段，运营商复用 `balance_type='api'` + `provider=carrier_*` 的组合，由 `fetchBalance` 按 provider 路由到对应查询器。

## 6. 已知限制与后续项

- **移动已联调，电信与联通未联调**：移动的入口、登录方式、余额文案、提取结果均已用真实页面确认（抓取值 70.9 与页面一致）。电信与联通仍需你本人完成一次网厅登录后才能确认余额页文案；若某家抓不到，按 §7 的方式调规则即可。
- **同一页面存在多个金额，取错会误报欠费**：移动个人中心页同时有「可用余额 70.90元」与「账户总余额 0.00元」。若误取后者，会把 0 当成欠费并错误触发充值单。已为此实现排除词机制（`exclude`）：标签含「账户总/总额/累计/预存/冻结/赠费」的金额一律不采信；且关键字兜底路径要求关键字与数字之间只允许分隔符，不允许夹杂其他中文标签。两条都有回归用例覆盖。
- **电信需要桌面 Chrome**：实测 189.cn 对无头浏览器做站点级拦截（页面正文 0 字）。电信的自动抓取依赖 `scripts/start-chrome-debug.cmd` 启动的桌面 Chrome 调试模式；无头失败时代码会自动回退到 CDP 模式重试，两者都不可用时请改用手动录入。
- **依赖登录态**：登录态过期（运营商通常几天到几周）会导致抓取失败。系统已有连续 3 次失败推手机提醒的机制，但重新登录仍需你本人操作。
- **联通的余额在二级菜单**：首页没有余额链接，需要先展开「查询」再点二级入口，规则已按此顺序配置，但仍可能因省份版本差异而失效。
- **运营商风控**：频繁访问网厅可能触发验证码或限流。巡检频率为每小时一次，属正常用户量级，但异常时会失败并记录错误，不会静默返回 0。
- **只取话费余额**：当前只提取金额，流量余量与短信余量未提取（页面上标签与格式差异更大，且阈值告警语义不同）。需要时可在 `CARRIER_RULES` 里加 `dataKey` 字段扩展。
- **余额单位为元**：电信官方接口返回的是「分」，本项目抓取路径读的是页面展示的元，未做单位换算。
- **回退路径**：任何一家运营商抓取不稳，把该平台的 `balance_type` 改成 `manual`，用页面「录入余额」按钮手工录入，阈值告警照常工作。

## 7. 建议 audit/QA 验证点

| 项 | 步骤 | 期望 |
|---|---|---|
| 解析正确性 | 运行 `node scripts/test-carrier-balance.mjs` | 41 项全通过，含真实移动页面正文（提取 70.9、不误取账户总余额 0）、负余额、千分位、栏目名不误命中、结构不符返回 null |
| 存量不受影响 | 运行 `npm test` | 37 项全通过，已有平台行为不变 |
| 登录流程 | 运行 `node scripts/wallet-login.mjs carrier_cmcc`，在弹窗输入短信验证码 | 提示「✓ 中国移动话费 登录成功，登录态已保存到 src/wallet-states/storage_carrier_cmcc.json」 |
| 抓取可用（已实测通过） | 运行 `node scripts/wallet-check.mjs 中国移动话费` | 输出 `OK 中国移动话费 : 70.9`；未登录则输出可读错误并列出缺登录态的平台 |
| 服务巡检链路（已实测通过） | 在页面点该平台的「刷新」按钮 | 返回 `{"ok":true,"balance":70.9}`，平台卡片显示余额 70.9 元且无错误标记，余额历史新增一条 |
| 未登录可读性 | 删除某运营商登录态文件后刷新该平台 | 返回「尚未登录 xxx：请先运行 node scripts/wallet-login.mjs carrier_xx」而非 500 |
| 失败不误建单 | 抓取失败后检查充值单列表 | 不产生新充值单（失败返回 null 而非 0） |
| 降级可用 | 把运营商平台 `balance_type` 改为 `manual` 并录入余额 | 前端显示正常，低于阈值时正常生成充值单 |

### 规则调优指引（抓不到余额时）

1. 看错误信息里的关键字组，确认网厅页面上的实际文案。
2. 在平台编辑页把 `balance_json_path` 填成 JSON，例如：
   ```json
   {"keywords":["账户余额","本月可用余额"],"regex":"(?:账户余额|本月可用余额)[\\s:：()（）¥￥元]*(-?\\d[\\d,]*(?:\\.[0-9]{1,2})?)","entries":["服务大厅","查询服务","话费账单"],"max":100000}
   ```
3. 或者直接改 `src/services/scraper_wallets.mjs` 的 `CARRIER_RULES`（三家的标签组、正则、菜单入口都在这里），改完重跑单元测试。

## 8. 回滚说明

本改动是纯增量，回滚成本低：

1. 删掉 `src/services/balance.js` 里的三个 `carrier_*` 查询器与 `scrapeCarrier()` 函数。
2. 删掉 `src/services/scraper_wallets.mjs` 里的 `CARRIER_RULES` / `CARRIER_ENTRY_URLS`，还原 `parseScrapeRule`、`extractBalance`、`enrichRuleWithBuiltin`、`scrapeOnePage`、`waitForKeyword` 的关键字处理为单字符串版本。
3. 删掉 `public/index.html` 里三个 provider 选项、图标、快速添加模板与 `isCarrier()` 相关判断。
4. 删掉 `scripts/wallet-login.mjs` 里 `provider LIKE 'carrier_%'` 的查询条件与三个预设项。
5. 删掉 `scripts/setup-carrier-platforms.mjs` 与 `scripts/test-carrier-balance.mjs`。
6. 数据库里删除三条 `provider LIKE 'carrier_%'` 的平台记录即可，已有平台数据不受影响。

回滚后 `npm test` 仍应 31 项（不含运营商新增的 6 项）全通过。

## 9. 官方文档出处

- 中国移动 IT 能力开放平台接口目录（查账户余额等）：`https://it.open.10086.cn/#/production/nav/refer`
- 中国移动 10086 帮助中心（个人查余额方式、登录密码种类）：`https://www.10086.cn/support/selfservice/account/ah/`
- 中国移动短信营业厅指令表（101/YE/CXYE 查余额等）：`https://www.jl.10086.cn/support/channelhelp/note/`
- 中国电信天翼开放平台「获取用户套餐信息」接口文档（`totalBalanceAvailable`，单位分）：`https://id.189.cn/html/api_detail_243.html`
- 中国电信天翼开放平台入驻与能力申请流程：`http://id.dlife.cn/wap/index.html`
- 中国电信广东网上营业厅余额查询自助说明：`https://gd.189.cn/support/newbin/yecx.htm`
- 中国联通 A-PaaS 能力开放平台 API 规范 v1.8（账户余额查询 §5.3、当月话费 §5.6、欠费查询 §5.4）：`https://m.wendangwang.com/doc/60c6cb07a89ca3610bac1bba82aa9558b00850a5/5`
- 中国联通网上营业厅查询入口（账户余额）：`http://iservice.10010.com/elecService/wap.html`

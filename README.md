# 相遇 MEETIN · 手机签到系统

单场活动的完整签到应用：主办方导入登记资料 → 参会者输入联系电话领码 → 主办方扫码查看身份 → 核对后确认签到。支持手机和电脑。本地默认使用 SQLite；线上 CloudBase 云托管连接共享 PostgreSQL，多台设备与多个容器实例共享名单和签到记录。

## 本地运行

需要 Node.js 22.13+（推荐 Node.js 24 LTS）。

```bash
npm install
npm run dev
```

- 参会者：`http://localhost:5173/`
- 主办方：`http://localhost:5173/admin`
- 首次进入后台自行设置至少 8 位管理密码。未初始化时，先在本机完成初始化，再对外开放。
- 手机与电脑连接同一个 Wi-Fi 后，把 `localhost` 换成电脑的局域网 IP。
- 手机相机只能在 HTTPS 下使用；HTTP 局域网访问可以领码、从相册识别二维码、按手机号查找和签到。
- 相机开启等待超过 12 秒会自动退出并提示重试；等待时可取消开启或使用相册识别。手机系统权限和当前网站权限都需要允许相机。

## 使用顺序

1. 打开后台，设置管理密码；在“活动设置”填写活动名称、日期、时间、地点。
2. 在“导入资料”上传文件，检查完整预览和识别提示，点击确认导入。
3. 将参会者页面地址发给来宾。来宾输入已登记联系电话，获取并保存二维码。同一电话登记多人时，需补填本人的报名姓名，每人领取独立二维码。
4. 工作人员登录同一个后台，在“扫码签到”打开相机，或从相册读取二维码。核对资料后点“确认签到”。没有二维码时可按电话查询；同一电话关联多人时，先选择实际到场人员，再核对资料并逐人签到。
5. 在“参会名单”搜索、筛选、查看详情，或导出 CSV 签到记录。

## 支持的文件

- **Excel `.xlsx` / CSV `.csv`**：第一行为列名，第一列为联系电话，后续列可任意扩展。同一电话可以登记多人，每人一行并填写“姓名”列。支持多个 Excel 工作表；CSV 使用 UTF-8。可以下载页面提供的模板。
- **Word `.docx`**：支持标准表格。正文建议每个人以手机号开头，后续按 `姓名：张晓`、`公司：相遇科技` 等逐行填写。会保留原始段落供核对。
- **PDF `.pdf`**：支持包含可提取文字的表格、手机号开头的资料段落。复杂排版必须在预览里人工核对。图片型 PDF / 扫描件没有 OCR，需要先转换为文字版或 Excel。
- 旧版 `.xls` / `.doc` 请在 Excel / Word 中另存为 `.xlsx` / `.docx`。
- 每次一个文件，最大 8 MB、10,000 人；PDF 最多 100 页。支持大陆 11 位手机号及带区号的座机（例如 `010-88886666`），支持清理 `+86` 前缀、空格和横线。
- 按“电话＋姓名”区分人员，文件内相同电话和姓名保留第一次出现的资料并提示。再次导入同一电话和姓名会更新资料，保留二维码与签到时间；修改姓名视为新增人员。同号同名人员请在姓名中添加区分标记（例如“张晓（销售部）”），领码时填写该完整姓名。导入预览 30 分钟有效。

## 数据与访问

- 默认数据库：`data/checkin.sqlite`。**备份请包含整个 data 目录或使用 SQLite 在线备份；数据库运行时不要单独复制主文件而遗漏 WAL。**
- 管理密码使用 scrypt 加盐散列，登录会话存储于数据库，HttpOnly / SameSite Cookie，12 小时有效。
- 二维码是随机 192 位凭证，不编码手机号或身份信息。领取接口仅返回凭证和脱敏电话；同号多人时只提示填写姓名，不公开人员名单。查看身份信息必须登录后台。
- 按用户需求采用“手机号领码”，没有短信验证；它不证明手机号归属。工作人员必须核对来宾身份，二维码不要转发给他人。
- 签到操作具有幂等性：重复扫描会提示已签到，不会修改首次签到时间。统计与记录由服务器统一保存。
- 默认单主办方密码、单场活动。没有短信服务、图片 OCR 或多活动管理。
- 原始文件只在解析时保留于内存；识别结果和导入记录存储在本机服务器，不发送给 AI 服务。

## 构建和部署

升级此版本时先执行 `npm run db:migrate`，将原手机号唯一约束迁移为“电话＋姓名”唯一约束。迁移保留人员 ID、二维码、资料和签到时间；SQLite 启动时自动迁移。此前导入时已被旧规则丢弃的同号人员，需要重新导入原始名单。

```bash
npm run build
npm start
```

构建后的服务默认在 `http://localhost:3001` 同时提供网页与接口。

可选环境变量（进程环境注入，不自动读取 `.env`）：

| 变量 | 用途 |
| --- | --- |
| `PORT` | HTTP 端口，默认 `3001` |
| `DATA_DIR` | 持久数据目录，默认 `./data` |
| `PUBLIC_ORIGIN` | 外部访问的完整来源，如 `https://checkin.example.com`，不含末尾斜杠；反向代理部署建议设置 |
| `TRUST_PROXY=1` | 仅在可信的单层反向代理后启用，识别 HTTPS 并使用 Secure Cookie |
| `ADMIN_PASSWORD` | 首次生产启动必须设置 8–128 位管理密码；仅在数据库尚无密码时初始化，不覆盖已有密码 |
| `DATABASE_URL` | 通过 TCP 连接 PostgreSQL 时使用的连接串，优先选用数据库服务商提供的连接池入口；不得进入前端 |
| `DB_POOL_MAX` | 每个函数实例的 PostgreSQL 连接上限，默认 `3`；须结合实例总数与数据库连接预算调整 |
| `DB_HTTP_MAX` | CloudBase SQL HTTP 通道每实例同时请求上限，默认 `8`；最多排队 `100` 条、等待 `5` 秒，网络请求超时 `30` 秒 |
| `DB_MIGRATE_ON_START=0` | PostgreSQL 已执行 `npm run db:migrate` 后，可跳过冷启动建表与索引检查；默认自动迁移，CloudBase HTTP 通道也支持 |
| `TICKET_IP_LIMIT` | 单 IP 每分钟领码请求上限，默认 `600`；同时单人电话每分钟最多 `5` 次；同号多人时电话总额度为人数 × `10`，同一电话＋姓名每分钟最多 `5` 次；各维度跨实例共享 |
| `CLOUDBASE_ENV_ID` | CloudBase 环境 ID。与 `CLOUDBASE_API_KEY` 同时设置时改用云开发 PostgreSQL，此时忽略 `DATA_DIR` 与 `DATABASE_URL` |
| `CLOUDBASE_API_KEY` | 云开发 API Key（`service_role`），用于调用环境网关的 SQL 接口。仅在服务端环境变量中配置，不得进入前端或版本库 |
| `APP_REVISION` | 可选，仅用于 `/api/health` 返回部署标记，便于确认线上版本 |

正式手机扫码使用 HTTPS 域名。反向代理保留 Host，并发送正确的 X-Forwarded-Proto；配置持久磁盘挂载 `DATA_DIR`，否则容器重建会丢失名单。仅运行一个服务实例共享同一个 SQLite 数据目录。

`PUBLIC_ORIGIN` 未设置时，来源校验按请求自身的 `Host` 推导，因此换绑域名无需改动配置；若设置了它，换绑域名后必须同步更新，否则所有写操作会返回 403。

Docker 示例：

```bash
docker build -t meetin .
docker run -d --name meetin -p 3001:3001 -e ADMIN_PASSWORD -v meetin-data:/app/data meetin
```

运行容器前，通过本机环境安全设置 `ADMIN_PASSWORD`，不要把密码写进 Dockerfile 或版本库。Zeabur 部署选择仓库的 `main` 分支，使用根目录 Dockerfile，添加 `/app/data` 持久卷，并在环境变量中设置 `ADMIN_PASSWORD`、`TRUST_PROXY=1` 和实际 HTTPS 地址对应的 `PUBLIC_ORIGIN`。

### 腾讯云 EdgeOne Pages 部署（备选）

网页构建到 `dist`，`cloud-functions/api/[[default]].ts` 承接 `/api/*`。每个存活实例复用应用与数据库连接池，签到、会话和限流状态保存在共享 PostgreSQL 中。云函数的临时目录不保存名单。

部署与容量检查见 [EdgeOne 并发部署说明](deploy/edgeone-concurrency.md)。代码已有 `edgeone.json`，其中 `maxDuration: 120` 是请求时长上限，**不是并发数设置**。实际云函数并发配额、数据库连接预算和部署地域需在当前项目控制台核实。

### 腾讯云开发 CloudBase 部署（当前使用）

线上参会者入口：<https://meetin-checkin-318387-12-1394197924.sh.run.tcloudbase.com/>，主办方后台：<https://meetin-checkin-318387-12-1394197924.sh.run.tcloudbase.com/admin>

- **环境**：`qiandaoxitong-d7gl6vybc25d31b3f`（上海）
- **服务**：云托管 `meetin-checkin`，容器型源码构建，端口 `3001`；原部署记录为 CPU 0.5 / 内存 1G / 实例 1–2，恢复服务后需核对实际配置
- **数据**：云开发 PostgreSQL（表：`settings`、`people`、`sessions`、`drafts`、`imports`、`rate_limits`、`uploads`）
- **架构**：前端构建产物与 API 由同一个容器、同一个域名提供。**不拆成「静态托管前端 + 云托管后端」是有意为之**——后端 Cookie 用 `SameSite=Strict` 并校验 `Origin` 头，跨域名调用会被浏览器直接拦截。

云开发 PostgreSQL **不向应用开放 TCP 连接**，只提供浏览器 SDK / PostgREST / MCP 管理面。因此 `server/db.ts` 里的 `openCloudBaseDatabase()` 走环境网关的 SQL 接口来实现既有的 `Database` 接口：

```
POST https://{envId}.api.tcloudbasegateway.com/v1/rdb/exec-pgsql
Authorization: Bearer <CLOUDBASE_API_KEY>
{ "sql": "SELECT ...", "parameters": [...], "role": "cloudbase_postgres" }
```

这个接口有三条硬约束，改数据层代码时必须遵守：

1. **一次只能执行一条语句**，多语句会被网关拒绝（`DATABASE_42601`），所以建表是逐条执行的。
2. **不返回受影响行数**，因此所有写入语句都要带 `RETURNING`，受影响行数由返回的行数推导。
3. **没有事务**。批量导入改为每 500 条一批的「集合式插入 + 集合式更新」，而不是逐条写入——否则 1 万人的名单会产生 1 万次网络请求。每一批自身是原子的，且可安全重跑。

本地开发完全不受影响：不设 `CLOUDBASE_*` 时仍用 SQLite；设 `DATABASE_URL` 时仍走 TCP PostgreSQL。

并发保护、容量配置与发布检查见 [CloudBase 并发部署说明](deploy/cloudbase-concurrency.md)。

发布新版本：

```bash
# 1. 生成只含源码的部署包（排除 node_modules / dist / data 等）
rsync -a --exclude node_modules --exclude dist --exclude data --exclude test-results \
  --exclude outputs --exclude .git --exclude .workbuddy --exclude .deploy \
  --exclude config --exclude deploy-args.json --exclude '*.tsbuildinfo' --exclude '.env*' ./ ./.deploy/

# 2. 触发云托管部署（先把 deploy-args.example.json 复制为 deploy-args.json 并填入真实值）
npx mcporter call cloudbase.manageCloudRun --config ./mcporter.json --args "$(cat deploy-args.json)" --output json
```

> **`mcporter.json` 必须放在项目根目录。** CloudBase MCP 要求部署源码路径位于其工作目录内，而 mcporter 会把 MCP 进程的工作目录设成配置文件所在目录；配置若放在 `config/` 下，部署会一直报「路径必须在当前工作目录内」。

云开发 API Key 在「身份认证 → API Key」中签发（类型选 `api_key`），只写入云托管的环境变量 `CLOUDBASE_API_KEY`，不要落到前端或版本库。

### Zeabur 镜像部署（备选）

当前服务通过 GitHub Container Registry 拉取镜像。每次推送到 `main`，GitHub Actions 会执行 Docker 构建中的测试并发布 `ghcr.io/zxc9802/qiandao:<完整提交 SHA>` 和 `latest`。镜像仅包含应用代码和运行依赖，不包含名单、数据库或密码。

在 Zeabur 的“设置 → 来源 → Docker 镜像”中填写 `ghcr.io/zxc9802/qiandao`，标签填写已成功构建的完整提交 SHA，端口使用 `3001` 或平台注入的 `PORT`，保留 `/app/data` 持久卷及上述环境变量。当前使用固定版本标签；之后更新时，先等待 Actions 成功，再将 Zeabur 镜像标签改为新提交 SHA 并保存。GitHub 推送会自动发布镜像，不会直接切换线上运行版本。

线上参会者入口：<https://qiandao-zxc9802.zeabur.app/>，主办方后台：<https://qiandao-zxc9802.zeabur.app/admin>。后台无需用户名，使用部署时设置的管理密码。

## 验证

```bash
npm test
npm run build
npm audit
```

测试包含真实 XLSX / DOCX / PDF / CSV 解析、登录鉴权、导入预览与提交、二维码查回、无效号码、重复导入、重复签到、来源校验、导出以及数据库重启后的持久化。浏览器验收记录见 `验收记录.md`。

技术：React、TypeScript、Vite、Express、SQLite、read-excel-file、Mammoth、PDF.js、QRCode、[qr-scanner](https://github.com/nimiq/qr-scanner)。

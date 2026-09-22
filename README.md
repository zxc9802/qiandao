# 相遇 MEETIN · 手机签到系统

单场活动的完整签到应用：主办方导入登记资料 → 参会者输入手机号领码 → 主办方扫码查看身份 → 核对后确认签到。支持手机和电脑，资料保存在服务端 SQLite 中，多台设备访问同一服务即可共享名单和签到记录。

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
3. 将参会者页面地址发给来宾。来宾输入已登记手机号，获取并保存二维码。
4. 工作人员登录同一个后台，在“扫码签到”打开相机，或从相册读取二维码。核对资料后点“确认签到”。没有二维码时可按手机号查询。
5. 在“参会名单”搜索、筛选、查看详情，或导出 CSV 签到记录。

## 支持的文件

- **Excel `.xlsx` / CSV `.csv`**：第一行为列名，第一列为手机号，后续列可任意扩展。支持多个 Excel 工作表；CSV 使用 UTF-8。可以下载页面提供的模板。
- **Word `.docx`**：支持标准表格。正文建议每个人以手机号开头，后续按 `姓名：张晓`、`公司：相遇科技` 等逐行填写。会保留原始段落供核对。
- **PDF `.pdf`**：支持包含可提取文字的表格、手机号开头的资料段落。复杂排版必须在预览里人工核对。图片型 PDF / 扫描件没有 OCR，需要先转换为文字版或 Excel。
- 旧版 `.xls` / `.doc` 请在 Excel / Word 中另存为 `.xlsx` / `.docx`。
- 每次一个文件，最大 8 MB、10,000 人；PDF 最多 100 页。大陆 11 位手机号，支持清理 `+86` 前缀、空格。
- 文件内重复手机号保留第一次出现的资料并提示。再次导入同一手机号会替换该人的资料，保留二维码与签到时间。导入预览 30 分钟有效。

## 数据与访问

- 默认数据库：`data/checkin.sqlite`。**备份请包含整个 data 目录或使用 SQLite 在线备份；数据库运行时不要单独复制主文件而遗漏 WAL。**
- 管理密码使用 scrypt 加盐散列，登录会话存储于数据库，HttpOnly / SameSite Cookie，12 小时有效。
- 二维码是随机 192 位凭证，不编码手机号或身份信息。领取接口仅返回凭证和脱敏手机号，查看身份信息必须登录后台。
- 按用户需求采用“手机号领码”，没有短信验证；它不证明手机号归属。工作人员必须核对来宾身份，二维码不要转发给他人。
- 签到操作具有幂等性：重复扫描会提示已签到，不会修改首次签到时间。统计与记录由服务器统一保存。
- 默认单主办方密码、单场活动。没有短信服务、图片 OCR 或多活动管理。
- 原始文件只在解析时保留于内存；识别结果和导入记录存储在本机服务器，不发送给 AI 服务。

## 构建和部署

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

正式手机扫码使用 HTTPS 域名。反向代理保留 Host，并发送正确的 X-Forwarded-Proto；配置持久磁盘挂载 `DATA_DIR`，否则容器重建会丢失名单。仅运行一个服务实例共享同一个 SQLite 数据目录。

Docker 示例：

```bash
docker build -t meetin .
docker run -d --name meetin -p 3001:3001 -e ADMIN_PASSWORD -v meetin-data:/app/data meetin
```

运行容器前，通过本机环境安全设置 `ADMIN_PASSWORD`，不要把密码写进 Dockerfile 或版本库。Zeabur 部署选择仓库的 `main` 分支，使用根目录 Dockerfile，添加 `/app/data` 持久卷，并在环境变量中设置 `ADMIN_PASSWORD`、`TRUST_PROXY=1` 和实际 HTTPS 地址对应的 `PUBLIC_ORIGIN`。

### Zeabur 镜像部署（当前使用）

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

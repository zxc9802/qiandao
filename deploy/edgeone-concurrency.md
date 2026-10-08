# EdgeOne Pages 并发部署说明

适用范围：单场活动，多位来宾领码、多位工作人员同时扫码。多个主办方的账号和活动隔离不在此次修改范围内。

## 已实现的保护与优化

- 领码：每个标准化手机号每分钟 5 次；每个 IP 每分钟默认 600 次，支持 `TICKET_IP_LIMIT` 调整。IP 与手机号计数在一条 SQL 中原子递增、到期重置，所有实例共享。非法号码仍计入 IP 配额；被限流返回 429 和 `Retry-After`。手机号不作为明文限流键保存。
- 签到：保留 `WHERE checked_at IS NULL` 条件更新，成功时 `RETURNING *` 直接返回首次时间；重复请求查询已保存的结果。100 个并发请求只能有一次首次签到。必须在数据库提交后才响应成功。
- 活动信息缓存 5 秒、后台统计缓存 2 秒，同一实例的并发缓存未命中合并成一次加载。当前实例修改后清缓存，其他实例在 TTL 后刷新。身份查询、签到、登录权限不使用缓存；HTTP API 仍为 `no-store`，不会被 CDN 缓存。
- PostgreSQL 每实例默认最多 3 个连接，空闲 10 秒回收，获取连接最多等 5 秒，每条 SQL 最长 15 秒。排队查询达到 100 后拒绝新的查询。数据库繁忙或暂时不可用时返回 503 和 `Retry-After: 2`，不伪装成参数错误。
- 新增签到时间排序索引、限流过期时间索引。并发冷启动通过 PostgreSQL 事务级 advisory lock 串行执行建表，避免初始化冲突。

成功领码由原来的 3 次数据库操作减为 2 次；首次确认签到（含鉴权）由 3 次减为 2 次；二维码查身份仍为 2 次。缓存仅是减少读取的优化，不能当作跨实例同步机制。

## 发布设置

| 配置 | 设置方法 |
| --- | --- |
| `DATABASE_URL` | 所有生产函数实例使用同一 PostgreSQL。若数据库提供 PgBouncer 或其他池化连接地址，优先使用；保留服务商要求的 TLS 配置 |
| `DB_POOL_MAX` | 初始保留 `3`，不要直接改成几十；所有实例的连接预算总和必须小于数据库可用连接数 |
| `TICKET_IP_LIMIT` | 默认 `600` 请求/分钟；按最大共用 Wi-Fi 人数、领码集中时间及重试余量压测后调整，手机号限制仍保留 |
| `TRUST_PROXY` | 按实际可信代理链填写跳数（例如已核实只有一层时用 `1`）或可信代理地址/CIDR 列表。不要盲目设为信任所有来源 |
| `PUBLIC_ORIGIN` | 对外实际使用的 HTTPS 来源，不带末尾 `/`；换域名后同步调整 |
| `APP_REVISION` | 填本次版本标记，发布后检查 `/api/health` 返回值 |
| `DB_MIGRATE_ON_START` | 默认自动建表。先在可访问目标数据库的环境执行 `npm run db:migrate`，确认成功后可设 `0`，减少每次冷启动的 DDL 往返。以后涉及表/索引修改也必须先迁移 |

EdgeOne 入口要求 `DATABASE_URL`。不要在这个项目保留旧 CloudBase 的 `CLOUDBASE_ENV_ID` / `CLOUDBASE_API_KEY`，因为现有数据层在这两个变量同时存在时会优先选择旧通道。

函数地域选择尽量靠近数据库。`edgeone.json` 的 `maxDuration: 120` 只设置最长执行时间；不要添加未经官方支持的 `maxInstances` 等字段。云函数配额需以当前账号/项目为准，不能套用其他腾讯云产品的默认配额。

连接预算示例（不是本项目实际配置）：数据库上限 100、预留运维与其他服务 20，则应用预算为 80。如果最多 20 个实例，每实例 3 个连接共 60，可留出余量。如果平台无法约束实例数量，应使用数据库连接池代理控制后端连接数，单个应用实例内的连接池不能限制全局连接数。

## 限流记录清理

每次请求不再删除过期记录。过期键在被再次访问时原子重置；不再访问的旧键由维护命令回收：

```sh
npm run db:cleanup
```

在注入目标数据库环境变量的运维环境中执行；建议每天安排一次外部定时任务。该命令只删除已过期超过 24 小时的限流记录，不删除名单、签到或登录会话。本次提供了命令，未代建云端定时任务；云函数可能冻结或回收，不能依赖进程内 `setInterval` 完成日常清理。

## 验证与压测

```sh
npm test
npm run build
TEST_POSTGRES=1 node --import tsx --test tests/checkin.test.ts
npm run test:load
```

`TEST_POSTGRES=1` 是嵌入式 PGlite 的 SQL 兼容性测试，不代表真实多连接竞争。验证真实 PostgreSQL 时，在独立测试数据库设置 `TEST_DATABASE_URL`，然后运行：

```sh
node --import tsx --test tests/concurrency.test.ts
LOAD_CONCURRENCY=100 npm run test:load
```

测试会创建随机命名 schema 和两个本地应用实例，结束后仅清理自己创建的数据。压测固定 500 名虚拟来宾，顺序经历查看活动、领码、查询身份、确认签到，并夹杂统计刷新；默认同时运行 50 条来宾流程，最多可设 100。输出每个接口的 P95、最大延迟、错误和最终签到人数。不要把本机测得的吞吐率当作 EdgeOne 线上容量。

发布验收需补齐：真实手机网络和共用 Wi-Fi 的 IP 识别；部署版本标记；线上同等配置的独立测试活动/项目压测；数据库连接峰值、函数限流与超时；最终签到人数和导出记录一致。上线前可先把“无丢失/重复签到、正常来宾无误限流、业务请求 P95 小于 1 秒”作为待验证目标，按活动需求调整。

参考：[EdgeOne 云函数](https://pages.edgeone.ai/zh/document/cloud-functions)、[Node Functions](https://pages.edgeone.ai/zh/document/node-functions)、[node-postgres 连接池容量](https://node-postgres.com/guides/pool-sizing)、[代理 IP 与限流](https://express-rate-limit.mintlify.app/guides/troubleshooting-proxy-issues)。

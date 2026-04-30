# eval-server 不稳定根因分析（2026-04-30）

> gitnexus-dev agent 诊断报告
> 触发场景: batch 8 issue 中途 eval-server crash → cross-link 全 0 → 重启后立即恢复

---

## 真因（确诊，最高置信度）

**KuzuDB 1.4.1 N-API SIGSEGV** — Intel macOS 上 `conn.close()` 析构函数 null-pointer dereference。

### 直接证据

`~/Library/Logs/DiagnosticReports/` 里今日有 **7 个 crash report**，全部是：

```
SIGSEGV
EXC_BAD_ACCESS
KERN_INVALID_ADDRESS at 0x0000000000000008
native image: kuzujs.node
```

地址 `0x0000000000000008` 是经典 null-pointer + 8 字节 offset → 对应 C++ 代码 `ptr->field` 中 `ptr == nullptr`。

### Crash 触发链

1. eval-server 注册了 19 个仓（registry.json）
2. 1.4.1 用 `dist/mcp/core/kuzu-adapter.js` 连接池（**不是** `dist/core/kuzu/kuzu-adapter.js`）
3. `MAX_POOL_SIZE = 15`，每仓预热 `INITIAL_CONNS_PER_REPO = 2`
4. 当并发请求命中 ≥4 个仓 → 池满 → LRU 驱逐 → `conn.close()` N-API 析构 → SIGSEGV
5. 进程瞬间死，stdout/stderr 没任何输出（这就是 `/tmp/eval-server.log` 干净的原因）

### 为什么 batch 8 issue 中途就死

8 个 issue 涉及 cses-java + mattermost 2 个仓 + crossBlastRadius 还要查 partner，触发频次升高 → LRU 驱逐 → crash。

### 为什么"重启一次就稳"

那次启动后实际访问的仓数 < 15，LRU 驱逐没触发，析构 bug 没激活。**不是真稳，是侥幸**。

---

## 次因（不会 crash，但会让 cross-link 错乱）

### `isWriteQuery` 正则误拦真实 cypher

`dist/mcp/local/local-backend.js:41`：

```js
CYPHER_WRITE_RE = /\b(CREATE|DELETE|SET|MERGE|REMOVE|DROP|ALTER|COPY|DETACH)\b/i
```

没有 `(?<!:)` 前缀保护（1.6.2 修了）。Cypher 字面量含 `createChannel` / `delete` / `merge` 等会被整条 cypher 误判为写操作返回 error。

**已知绕开**：`mcp-bridge.ts:safeNameEqualsClause` 含 guard 关键字时拆 STARTS WITH/ENDS WITH 字面量，不直接写 `name = "createChannel"`。

---

## 4 个守护方案对比（agent 给的）

| 方案 | 工作量 | 守护强度 | 副作用 |
|---|---|---|---|
| A · bash watchdog cron | 低 | **弱** — cron 1 分钟粒度，最坏 1 min 服务不可用 | webhook in-flight 请求全丢 |
| B · launchd plist (macOS systemd) | 中 | **强** — KeepAlive=true 秒级重启 | 需 launchctl load，macOS 升级要重 load |
| **C** · webhook 内嵌 child_process spawn + 监听 exit | 高 | 强 | webhook 重启也死 eval-server，违反单一职责 |
| **D** · pm2 (`pm2 start ... --name eval-server`) | **极低** | **强** — crash 后秒级重启 + 日志 + `pm2 startup launchd` 系统级守护 | 多一个全局进程；pm2 偶发内存泄漏（不影响） |

**推荐方案 D**（pm2）：1 行命令落地，crash 后秒级重启 + 日志旋转 + 系统级守护。

---

## 立即可执行的守护落地

### 一次性安装 + 启动 pm2 守护

```bash
# 安装 pm2 (如果没装)
npm i -g pm2

# 杀掉当前裸跑的 eval-server
pkill -f "gitnexus eval-server" 2>/dev/null
sleep 1

# pm2 守护启动
pm2 start "$(which gitnexus) eval-server --port 4848" \
  --name eval-server \
  --max-memory-restart 4G \
  --time \
  -- 

# 系统级开机自启 (生成 launchd plist)
pm2 startup launchd
# 按提示跑它给的 sudo 命令

# 保存当前进程列表
pm2 save

# 验证
pm2 status
curl -sf http://localhost:4848/health | head
```

### Crash 后 pm2 行为

- SIGSEGV 后 pm2 秒级 spawn 新进程
- stdout → `~/.pm2/logs/eval-server-out.log`
- stderr → `~/.pm2/logs/eval-server-error.log`
- 自动旋转（达 max_size 切割）
- 重启次数 + 上次 crash 时间 `pm2 status` 可见

### 想看更多 crash 细节

加 Node Diagnostic Report：

```bash
NODE_OPTIONS="--diagnostic-dir=/tmp/node-diag" \
  pm2 restart eval-server --update-env
```

下次 crash → `/tmp/node-diag/node.report.<pid>.<ts>.json` 含 JS + native 完整栈帧。

---

## 长期修复路径（agent 排序）

| 优先级 | 路径 | 阻塞点 |
|---|---|---|
| 1 | 升 1.6.x（切 LadybugDB，无 KuzuDB N-API bug）| **`@ladybugdb/core-darwin-x64` 缺 prebuilt** (Intel Mac dlopen 失败 — task #14 已跟) |
| 2 | 1.4.1 给 eval-server 加 `process.on('uncaughtException')` | 对 SIGSEGV 无效，native crash 拦不到 |
| 3 | 降 `MAX_POOL_SIZE` 5（跟 1.6.x 一致）| 要改 1.4.1 安装包源码，不现实 |
| 4 | 升 KuzuDB 1.5+（修了 close N-API）| `kuzu@0.x` API 变了，破坏兼容性 |
| **5** | **pm2 守护现状 + 等 1.6.x ladybugdb 落地** | **当前最可行** ✓ |

---

## 关键结论（3 行）

1. **crash 真因**：KuzuDB 1.4.1 在 Intel macOS LRU 驱逐时 `conn.close()` N-API 析构函数 null-ptr deref（7 个 .ips 全是这个）
2. **"重启就稳"是侥幸**：那次启动后访问仓数没触发 LRU 驱逐，bug 没激活
3. **cross-link 全 0 是另一个 bug**（1.4.1 isWriteQuery 正则误拦），跟 crash 无关，已被 `safeNameEqualsClause` 绕开

---

## 行动建议

**今天能做**：跑一行 `pm2 start "gitnexus eval-server --port 4848" --name eval-server` 立即解 P0
**这周能做**：盯 `~/.pm2/logs/eval-server-error.log` 看 crash 频次是否符合预期
**等 ladybugdb prebuilt**：（task #14）就绪后切 1.6.x，根治 KuzuDB N-API segfault

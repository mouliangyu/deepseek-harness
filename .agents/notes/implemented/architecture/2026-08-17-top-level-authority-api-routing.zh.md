# Agent Note: 顶层 authority 路由覆盖所有客户端插件

Status: implemented

[English](2026-08-17-top-level-authority-api-routing.md) | 中文

## 问题

额外 DSH authority 使用官方 `IApiClient`，但 session-scoped 客户端插件并非全部经过 `SessionRuntime`。模型选择、命令、设置与其他消费者可能直接捕获 `ctx.connection.api`。只安装在某个 runtime 内的 router 会产生分裂行为：Workspace 与 Session 列表可以显示远端会话，相邻插件却会把该会话 id 发给本地 Host。

## 决策

`ConnectionHandle.routeApi()` 注册一个可释放的顶层 API router。注册期间，`api` 属性返回该 router，因此现有客户端插件共享同一个 authority 决策，无需增加 authority 专属分支。已有 router 时再次注册会明确失败。

连接插件单独保留原始本地 API。`ConnectionController` 使用该本地 API 执行 `host.describe`、本地 mux 与 Host 下行、重连 generation 和 transport teardown。router 可以聚合或分发应用 RPC，而不会把本地连接循环递归路由回自身。

Authority provider 继续拥有 transport、重连和健康状态。router 只负责请求选择、标识符隔离，以及把远端 frame 投影到共享客户端对象模型。

## 结果

远端 Workspace 与 Session id 可以经过普通客户端插件，包括模型选择与交互 responder，而无需修改这些消费者。router teardown 会恢复本地 API，使 Cordis 插件卸载保持可逆。

同一时间只能存在一个顶层 router。需要拦截 API 的独立功能必须在该 router 内组合，而不能注册相互竞争的替代项。router 故障会影响全部应用 RPC，但本地连接 generation 仍可独立恢复。

## 已考虑的替代方案

- **只在 `SessionRuntime` 内路由**：拒绝，因为直接捕获 `ctx.connection.api` 的客户端插件会绕过该 runtime。
- **让每个客户端插件理解 authority**：拒绝，因为这会重复路由策略，并迫使新增消费者默认感知远端。
- **让顶层 API router 接管本地连接循环**：拒绝，因为聚合路由可能递归调用自身，并让远端 provider 故障控制本地 transport 就绪状态。

## 验证

连接测试固定了独占注册、路由后读取、幂等释放与本地 API 恢复。浏览器验证打开远端 root session、加载远端模型目录、发送 prompt、在普通 conversation UI 中渲染实时 `session/event` frame 并完成响应。

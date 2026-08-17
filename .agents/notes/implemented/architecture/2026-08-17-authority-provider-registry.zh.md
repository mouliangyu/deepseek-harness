# Agent Note: Authority provider 注册表

Status: implemented

[English](2026-08-17-authority-provider-registry.md) | 中文

## Problem

客户端 runtime 假定只有一个进程内 DSH host。远程 host、容器或其他 transport 需要公开同一套官方 `IApiClient`，且不能在 core 中增加 transport 专属的项目、会话或事件协议。core 仍需统一识别可用 authority、协调连接生命周期，并在 teardown 时释放连接。

## Decision

`dsh-client-connection` 的浏览器半提供 `ctx.authorityRegistry`。authority provider 具有稳定的 id 和 kind，并建立携带官方 `IApiClient` 的 `AuthorityConnection`。provider 自行管理 transport 建立、重连、认证和可选的健康检查，只向注册表报告 `connecting`、`ready`、`degraded`、`failed` 与 `closed` 这组共享生命周期状态。

注册表管理注册、查询、连接尝试合并、生命周期快照、订阅和 teardown。它不探测 provider，不重试 transport，不解释 provider 专属的健康细节，也不翻译 API 请求和事件 frame。移除 provider 后，尚未完成的连接不能进入注册表；如果连接在移除后完成，注册表会将其关闭。

工作区与会话标识仍由其官方 API 管理。聚合多个 authority 的消费者必须在不透明的工作区和会话 id 旁保留 authority id，避免不同远端产生的相同 id 冲突，并确保请求返回产生该标识的 authority。

## Alternatives considered

**在 core 中实现 SSH 和远程健康逻辑。** SSH 只是一种 provider 类型，其进程、认证和重试行为不适用于容器、本地进程或未来 transport。让 core 承担这些策略会使共享 runtime 与单一 transport 耦合。

**定义单独的远程项目和会话协议。** 翻译协议会复制官方 DSH API、持久化、事件 frame、审批与取消行为。provider 直接公开 `IApiClient`，普通 runtime 与 UI 因而可以消费同一组操作。

**让各个功能独立发现 provider。** 多个注册表会造成连接所有权与 teardown 不一致，并使跨 authority 路由依赖隐式约定。单一注册表统一标识与生命周期协调，同时保留 provider 对 transport 行为的所有权。

## Consequences

transport 插件可以添加顶层 authority，而无需改变官方 wire protocol，也无需让 core 理解其连接机制。并发消费者共享一次建立尝试，teardown 也有唯一所有者。runtime 聚合仍需支持 authority 感知的标识与路由；注册表有意不自行合并工作区或会话集合。provider 必须实现适合其 transport 的重连与健康行为，并在 core 移除或释放它时关闭资源。

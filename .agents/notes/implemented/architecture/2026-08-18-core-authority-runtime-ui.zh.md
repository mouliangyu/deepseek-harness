# Agent Note: Core 负责多 authority 客户端行为

Status: implemented

[English](2026-08-18-core-authority-runtime-ui.md) | 中文

## Problem

Authority registry 与 API router 可以连接额外的 DSH，但 client runtime 与 Workspace UI 原本只假设一个 Host。只提供 provider 的插件无法让远端 Workspace 出现在普通列表、路由定向 Session 请求、订阅远端事件流，也无法从现有添加 Workspace 流程选择远端目录。维护复制的 runtime 与 UI 包还会重复大部分官方 client 代码。

## Decision

`dsh-client-runtime` 负责通用 authority router 与事件流合并。它聚合本地及已连接 authority 的基线，为 authority 所有的 id 在浏览器对象模型中添加 namespace，路由定向调用与交互响应，并把官方 authority frame 投影到现有 Session 与 Workspace manager。`dsh-client-ui-workspace` 负责目录操作的 authority 选择，并渲染 Workspace id 携带的 authority 标签。两个包都消费与 provider 无关的 `ctx.authorityRegistry`，不认识 SSH 或其他具体 transport。

`dsh-remote` 保持为 provider 插件。它发现 SSH alias、启动或复用官方远端 Web Host、转发官方 HTTP/WebSocket 协议，并注册生成的 `IApiClient`。它不再替换 runtime 或 Workspace UI 包。

不携带 session 或 workspace id 的配置 API 使用共享 router 中显式选择的配置 authority 作用域。模型设置页可以选择本地或 ready provider，因此凭据与模型设置会写入目标 authority 的官方 DSH。

## Alternatives considered

**在第三方仓库继续维护复制的 runtime 与 UI 包。** 拒绝，因为复制包包含几乎完整的官方 client surface，每次上游变更都需要同步修复。

**把远程管理留在独立设置应用中。** 拒绝，因为远端 root session 无法使用普通 Workspace、Session、模型、交互与实时事件 UI。

**只让 `dsh-remote` 在运行时 patch 现有 UI。** 拒绝，因为原服务捕获单一 Host API，组件 contract 也没有暴露 authority 选择或事件源注册能力。

## Consequences

任何提供官方 `IApiClient` 的 provider 都可以参与同一套顶层 Workspace 与 Session UI。Core runtime 现在拥有 identifier namespace 与聚合语义，因此这些语义必须保持 provider-neutral 并由 core 测试覆盖。`dsh-remote` 的依赖与发布范围更小，社区仓库不再需要 shadow 官方名称的包。

## Verification

Core runtime 测试覆盖 authority id 映射、定向路由、基线聚合、交互响应路由、本地普通行为与 authority 事件投递。Workspace 测试覆盖 ready authority 菜单项、目录目标选择与 authority 标签。Remote provider 测试继续覆盖 SSH 发现、转发、官方 WebSocket frame、生命周期与远端 API 行为。

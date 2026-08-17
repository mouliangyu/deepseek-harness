# Agent Note: Top-level authority routing covers every client plugin

Status: implemented

English | [中文](2026-08-17-top-level-authority-api-routing.zh.md)

## Problem

Additional DSH authorities use the official `IApiClient`, but session-scoped client plugins do not all call through `SessionRuntime`. Model selection, commands, settings, and other consumers may capture `ctx.connection.api` directly. A router installed only inside one runtime therefore creates split behavior: Workspace and Session lists can show a remote session while a sibling plugin sends that session id to the local Host.

## Decision

`ConnectionHandle.routeApi()` registers one reversible top-level API router. The `api` property returns that router while it is registered, so every existing client plugin uses the same authority decision without authority-specific branches. Registration fails when another router is active.

The connection plugin retains the original local API separately. `ConnectionController` uses that local API for `host.describe`, the local mux and Host downlinks, reconnect generations, and transport teardown. A router can aggregate or dispatch application RPCs without recursively routing the local connection loop through itself.

Authority providers continue to own transport, reconnect, and health. The router owns only request selection, identifier isolation, and remote frame projection into the shared client object model.

## Consequences

Remote Workspace and Session ids can flow through ordinary client plugins, including model selection and interactive responders, without changes to those consumers. Router teardown restores the local API, which keeps Cordis plugin unload reversible.

Only one top-level router can be active. Independent features that need API interception must compose inside that router instead of registering competing replacements. A faulty router can affect every application RPC, while the local connection generation remains independently recoverable.

## Alternatives considered

- **Route only inside `SessionRuntime`** — rejected because client plugins that capture `ctx.connection.api` bypass that runtime.
- **Teach each client plugin about authorities** — rejected because it duplicates routing policy and makes new consumers remote-aware by default.
- **Route the local connection loop through the top-level API** — rejected because aggregate routing could recurse into itself and make remote provider failure control local transport readiness.

## Verification

Connection tests pin exclusive registration, routed reads, idempotent disposal, and restoration of the local API. Browser verification opens a remote root session, loads its remote model catalog, sends a prompt, renders live `session/event` frames, and completes in the ordinary conversation UI.

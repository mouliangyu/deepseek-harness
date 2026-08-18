# Agent Note: Core owns multi-authority client behavior

Status: implemented

English | [中文](2026-08-18-core-authority-runtime-ui.zh.md)

## Problem

The authority registry and API router can connect an additional DSH host, but the client runtime and Workspace UI originally assume one Host. A provider-only plugin could not make remote Workspaces appear in the ordinary list, route targeted Session calls, subscribe to remote event streams, or choose a remote directory from the existing add-Workspace flow. Maintaining copied runtime and UI packages duplicated most of the official client surface.

## Decision

`dsh-client-runtime` owns the generic authority router and event-stream fan-in. It aggregates local and connected authority baselines, namespaces authority-owned identifiers in the browser object model, routes targeted calls and interaction responses, and projects official authority frames into the existing Session and Workspace managers. `dsh-client-ui-workspace` owns the authority selector for directory operations and renders the authority label carried by a Workspace identifier. Both packages consume the provider-neutral `ctx.authorityRegistry`; neither knows SSH or another transport.

`dsh-remote` remains a provider plugin. It discovers SSH aliases, starts or reuses the official remote Web Host, forwards the official HTTP/WebSocket protocol, and registers the resulting `IApiClient`. It does not replace the runtime or Workspace UI packages.

Configuration APIs without a session or workspace id use an explicit configuration authority scope in the shared router. The Models settings page selects local or a ready provider, so credentials and model settings are written to the intended official DSH.

## Alternatives considered

**Keep copied runtime and UI packages in a third-party repository.** Rejected because the copies track almost the entire official client surface and require synchronized fixes for every upstream change.

**Keep remote management in a separate settings application.** Rejected because it prevents remote root sessions from using the ordinary Workspace, Session, model, interaction, and live-event UI.

**Teach only `dsh-remote` to patch the existing UI at runtime.** Rejected because the original services capture a single Host API and their component contracts do not expose authority selection or event-source registration.

## Consequences

Any provider exposing the official `IApiClient` can participate in the same top-level Workspace and Session UI. The core runtime now owns identifier namespace and aggregation semantics, so those semantics must remain provider-neutral and covered by core tests. `dsh-remote` has a smaller dependency and release surface, while the community repository no longer needs packages that shadow official names.

## Verification

Core runtime tests cover authority id mapping, targeted routing, aggregate baselines, interaction response routing, ordinary local behavior, and authority event delivery. Workspace tests cover ready-authority menu entries, directory target selection, and authority labels. The remote provider tests continue to cover SSH discovery, forwarding, official WebSocket frames, lifecycle, and remote API behavior.

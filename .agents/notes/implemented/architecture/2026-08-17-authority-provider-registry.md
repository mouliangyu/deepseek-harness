# Agent Note: Authority provider registry

Status: implemented

English | [中文](2026-08-17-authority-provider-registry.zh.md)

## Problem

The client runtime assumes one process-local DSH host. A remote host, container, or another transport needs to expose the same official `IApiClient` without adding transport-specific project, session, or event protocols to core. Core still needs one place to identify available authorities, coordinate their connection lifecycle, and release them during teardown.

## Decision

The browser half of `dsh-client-connection` provides `ctx.authorityRegistry`. An authority provider has a stable id and kind and establishes an `AuthorityConnection` carrying the official `IApiClient`. The provider owns transport setup, reconnection, authentication, and optional health checks. It reports only the shared lifecycle states `connecting`, `ready`, `degraded`, `failed`, and `closed` to the registry.

The registry owns registration, lookup, connection-attempt coalescing, lifecycle snapshots, subscriptions, and teardown. It does not probe a provider, retry its transport, interpret provider-specific health details, or translate API requests and event frames. Removing a provider prevents an in-flight connection from entering the registry and closes that connection if it completes after removal.

Workspace and session identities remain owned by their official APIs. Consumers that aggregate multiple authorities must retain the authority id alongside opaque workspace and session ids so equal remote ids do not collide and requests return to the authority that produced them.

## Alternatives considered

**Put SSH and remote health logic in core.** SSH is one provider type and its process, authentication, and retry behavior do not apply to containers, local processes, or future transports. Making those policies core responsibilities would couple the shared runtime to one transport.

**Define a separate remote project and session protocol.** A translated protocol would duplicate the official DSH API, persistence, event frames, approvals, and cancellation behavior. Providers instead expose `IApiClient` so the normal runtime and UI can consume the same operations.

**Let each feature discover providers independently.** Independent registries would produce inconsistent connection ownership and teardown and would make cross-authority routing implicit. A single registry provides identity and lifecycle coordination while leaving transport behavior with providers.

## Consequences

Transport plugins can add top-level authorities without changing the official wire protocol or teaching core about their connection mechanism. Concurrent consumers share one establishment attempt and teardown has one owner. Runtime aggregation still requires authority-aware identities and routing; the registry deliberately does not merge workspace or session collections itself. Providers must supply reconnect and health behavior appropriate to their transport and must close resources when core removes or disposes them.

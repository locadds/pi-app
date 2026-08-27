# Xiaogui node interconnect LAN pilot

This directory contains an isolated, opt-in LAN pilot. It is not wired into
Electron startup, TaskHub, WORK, or renderer flows. Product composition must
keep both Hub and node roles disabled unless an operator supplies the explicit
pilot configuration, a concrete RFC1918 IPv4 interface, approved node
manifests, one unique token per node, and local human approval.

## Threat boundary

The first pilot transport is token-authenticated HTTP. Bearer tokens protect
request authorization, but HTTP does **not** provide confidentiality, peer
certificate authentication, or replay protection. Anyone able to observe the
pilot network can steal a bearer token and replay captured requests while that
token remains valid. Tokens must therefore be high-entropy, unique to one
nodeId, kept out of logs and ledgers, rotated after suspected exposure, and
used only on an isolated, trusted RFC1918 LAN during the pilot.

Wildcard, loopback, hostnames, public IPv4, link-local IPv4, CGNAT, and IPv6
addresses are rejected before listening or connecting. HTTPS origins are also
restricted to RFC1918 literal IPv4, but this slice does not add, provision, or
silently downgrade a TLS implementation. A production rollout requires a
separate reviewed transport decision with authenticated encryption and replay
mitigation.

## Persistence and disclosure limits

The Hub persists only bounded assignment envelopes, task identity digests,
lease/status fields, and result/reason digests under
`userData/xiaogui/node-hub/v1`. The worker ledger stores assignment and task
identity digests under `userData/xiaogui/node-worker/v1`. Neither layer stores
bearer tokens, prompt/full-text payloads, runtime-private identities, or local
paths. Persisted terminal, expired, claimed, running, or unknown task identity
always fails closed against duplicate execution.

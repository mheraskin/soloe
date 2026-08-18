# ADR 0003: Identify terminal controllers explicitly

Status: accepted

## Context

Terminal control crossed several independently reconnecting boundaries: the
Soloe Client, its Application Server connection, and the remote Device adapter.
A transport-local client ID and an increasing lease generation could reject old
events, but neither represented which Device controlled which Session.
Recreating an adapter could therefore make one Device appear to compete with
itself while the UI still displayed the same Device name.

## Decision

Every control grant and command identifies the Session, its owner Device, the
durable controlling Device, and the granted Lease ID. Session Control is the
binding between that Session and controlling Device; it is not another kind of
Session and is not a transport connection. The controlling Device ID is reused
across reconnects and remote Device-adapter replacement.

A monotonically increasing generation may order lease observations and fence
delayed state updates. It does not establish identity and is not sufficient to
authorize terminal input or resize.

Terminal Control Leases do not expire and are not released when a Client hides,
switches Sessions, disconnects, or rebuilds its Device adapter. Another Device
must explicitly take over control, producing a new Lease ID and generation.
Explicit release, Terminal exit, and Environment Runtime shutdown still clear
control.

## Consequences

- Reconnecting one Soloe Device deterministically resumes its Session Control.
- Elapsed time and transport lifecycle do not change the Controller.
- A different Device must explicitly take over before sending input or resize.
- Switching tabs changes the presented Session without releasing control of the
  previous Session or creating a second Session identity.
- Device names and transport endpoints are presentation and routing data, not
  authority.
- Input and resize are rejected unless all three control identifiers match.

## Rejected alternatives

- Generation-only authorization confuses event ordering with identity.
- Transport connection IDs make ownership change during reconnection.
- Short time-to-live leases drop control during ordinary inactivity and make
  input availability depend on renewal timing.

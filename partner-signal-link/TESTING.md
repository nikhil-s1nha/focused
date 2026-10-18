# Local integration verification

- 29 sender/controller and local HTTP tests passed with mock acquisition data.
- 2 Node receiver tests passed, including the real Python sender, authentication, malformed payload rejection, duplicate suppression and live SSE delivery.
- Signal Scope browser controls saved temporary loopback settings, sent a test blink accepted by the receiver, and started/stopped forwarding. No acquisition controls were used.
- Temporary local receiver was shut down and test credentials cleared. The sender API remains running at 127.0.0.1:8769, unconfigured and not forwarding.

Pending: partner LAN reachability, matching shared token, game adapter action and visible Quest effect. No sensor or human EEG validation was performed by these integration tests.

Partner compatibility: integer-millisecond timestamps, enabled/clients/accepted health format, exact-host permission and HTTP acknowledgement variants tested. Live read-only health at GAME_LAPTOP_IP:48080 succeeded and reported one client. Shared token entry, authenticated delivery and rendered game effects remain pending.

Authenticated cross-laptop test now passed: manual_test blink event 9eddfac8-342c-4c85-b44c-8937db91cee4 accepted by Nikhil’s receiver with one connected client, confirmed by matching last_event ID. Game applied/rendered confirmation pending. No sensor acquisition was involved.

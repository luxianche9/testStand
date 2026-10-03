# testStand Agent renderer

This module is adapted from the official `assistant-ui` OpenCode example and UI components at commit
`8bba3aaadcae042b4750436e6aa62bbba4815dde`:

- `examples/with-opencode`
- `packages/ui/src/components/assistant-ui`

Upstream is MIT licensed. testStand adaptations keep the existing Electron/OpenCode runtime and IPC,
translate product copy to Chinese, enable OpenCode-compatible text/image/PDF attachments, add model and Agent
selection, `/` commands and `@` project-file context, replace the persistent thread sidebar with a 16rem overlay
drawer, and consume the app-wide Tailwind design tokens and shared component library in
`src/renderer/ui` (precision-instrument tokens; the former `.tf-agent-theme` scope is gone). Voice and remote-image generation remain intentionally out of scope because the current sidecar does not
provide those adapters. The pinned OpenCode adapter leaves a newly selected thread as a disabled local placeholder
until its remote session is initialized, so all New actions await the assistant-ui thread-list runtime's
`initialize()` operation before continuing.

Custom slash commands are dispatched through OpenCode's `session.command` endpoint. Ordinary messages continue
through `@assistant-ui/react-opencode`, including streaming, cancellation, attachments, tool calls, permissions,
questions, retry/edit/branch behavior and session lifecycle management.

See `resources/assistant-ui` and `resources/fonts` for source and license notices included in packaged builds.

# Windows packaging and installed acceptance

Final installer: `dist/HardwareHarness-0.1.0-windows-x64.exe` (280,625,529 bytes).

SHA256: `FD97338FE9B064745431EC8AFB993A3F72BD84385EADC141162D1D4F2DC87899`.

The installer contains the final PyInstaller backend, CPython 3.11.15, uv 0.11.32,
HardwareHarness SDK 0.1.0, and the complete default offline wheelhouse. All 258
backend files were compared by SHA256 after copying into the packaged application
and again after installation. Both comparisons matched.

## Executed on 2026-09-14

| Check | Result |
| --- | --- |
| Final Windows x64 NSIS build | Passed |
| Unpacked application smoke | Passed |
| Silent install into `dist/安装 验收` | Passed |
| Installation denied writes using a verified ACL | Passed |
| Existing safeStorage ciphertext and backend shutdown E2E | 1 passed |
| Default project environment using bundled runtime and offline wheels | Passed |
| Two default application operations | Two separate succeeded Runs with measurements |
| Preview isolation | Both desktop bridge and Node `require` are undefined |
| Stop application | Service stopped |
| OpenCode sidebar, history drawer, application restart | Passed |
| Full observed process tree after shutdown | All 40 tracked processes exited |
| Silent uninstall | Passed; acceptance directory, uninstall entries, and shortcuts absent |
| Existing user/device profile | All 19 pre-existing JSON file hashes unchanged |

The process audit includes Electron, the frozen backend, uv, application-service
Python/uvicorn, worker Python, and OpenCode, plus their observed helper processes.
PID and process creation time identify only descendants of the test launch roots;
the audit does not rely solely on the two OpenCode PIDs.

Application launches received a System32-only PATH, `UV_OFFLINE=1`, a fresh cache,
and no project-runtime override. Python/uv from the development machine were not
used by the installed app. The project and installation paths both contain Chinese
characters and spaces. The installation ACL was restored before uninstalling.

## Evidence

- `backend-payload.json`: final frozen/backend payload hashes.
- `unpacked-applications.json`, `unpacked-process-cleanup.json`: unpacked smoke.
- `packaged-applications.json`: actual installed executable and succeeded Runs.
- `process-cleanup.json`: installed process identities and exit result.
- `installed-acceptance.log`: installation/ACL PowerShell transcript.
- `installation-result.json`: consolidated installed acceptance result.

Hidden-window preview submission uses the real HTML form's `requestSubmit()`;
Agent drawer actions use actual DOM button `click()`. These preserve native form
validation and application handlers. Visible pointer/keyboard interactions and
screenshots are covered by the separate Electron E2E suite. An earlier
`failed-applications-smoke.json` records a hidden-window synthetic-pointer issue;
it is diagnostic history, not the final application result.

## Not executed

An independent clean Windows machine and a physically disconnected network were
not tested. The development-machine offline-mode checks above do not substitute
for either acceptance scenario. No real hardware or live LLM-provider operation
was attempted by this packaging smoke.

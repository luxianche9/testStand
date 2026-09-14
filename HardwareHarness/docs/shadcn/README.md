# shadcn source and HardwareHarness adapters

Retrieved on 2026-09-10 using **shadcn CLI 4.21.0**, the official
**new-york-v4** component registry and **neutral** colors. The CLI version is
pinned; the hosted registry can change independently, so the unmodified JSON
snapshots below record the source actually used for this update.

| Snapshot | Official source | SHA-256 |
| --- | --- | --- |
| `new-york-v4.registry.json` | `https://ui.shadcn.com/r/styles/new-york-v4/{name}.json` | `382BFE33125E8ACA365612EFA19ECF737E530B41E0F686E27CE7A1EB9DC07CB4` |
| `neutral-color.json` | <https://ui.shadcn.com/r/colors/neutral.json> | `58F847C9413F0C0E326F4796702A40C31A6D115E2B73B07EDC288E7EF949AF7F` |
| `LICENSE.md` | <https://raw.githubusercontent.com/shadcn-ui/ui/main/LICENSE.md> | `1564074E13439397221FFD522E2E504D56561994A23D371AA5E3AD43E4F5423F` |

The registry snapshot contains `button`, `input`, `textarea`, `label`,
`native-select`, `checkbox`, `dialog`, `dropdown-menu`, `tooltip`, `badge`,
`card`, `skeleton`, and `style`, including the complete upstream file contents.
shadcn is MIT licensed; retain the included notice when distributing adapted
components.

## Retrieval

The download was staged outside the repository before adapting any component:

```powershell
$scratch = Join-Path $env:TEMP 'hardwareharness-shadcn-4.21.0-neutral'
New-Item -ItemType Directory -Path $scratch -Force | Out-Null
$names = @('button', 'input', 'textarea', 'label', 'native-select', 'checkbox',
  'dialog', 'dropdown-menu', 'tooltip', 'badge', 'card', 'skeleton', 'style')
$urls = $names | ForEach-Object { "https://ui.shadcn.com/r/styles/new-york-v4/$_.json" }
pnpm dlx shadcn@4.21.0 view @urls |
  Set-Content (Join-Path $scratch 'registry.json') -Encoding utf8NoBOM
Invoke-WebRequest 'https://ui.shadcn.com/r/colors/neutral.json' `
  -OutFile (Join-Path $scratch 'neutral-color.json')
```

`apps/desktop/components.json` records `new-york`, `neutral`, CSS variables,
Tailwind v4 and the `@renderer` aliases. `pnpm dlx shadcn@4.21.0 info -c
apps/desktop` validates the configuration and resolves the CSS and component
paths. The Electron application is correctly detected as a manual framework.

## Compatibility adaptations

These are visual adapters for the existing component interfaces, rather than
verbatim replacement components:

| Existing module | Adaptation |
| --- | --- |
| `shared/ui/button.tsx` | Upstream variants and neutral borders; retain compact sizes, forwarded ref, default `type="button"`, existing variants and `asChild`. |
| `shared/ui/input.tsx` | Upstream Input/Textarea/Label/NativeSelect styles; retain native element types, refs, events, numeric `size`, empty values, `optgroup`, disabled options and the Select wrapper's `className`. Textarea retains its existing minimum height and manual resize behavior. |
| `shared/ui/checkbox.tsx` | Upstream Checkbox and Tooltip styles; retain Radix three-state values, indicator, tooltip delay/offset, wrapper props and z-index. |
| `shared/ui/dialog.tsx` | Upstream neutral border, surface, radius and shadow; retain the existing Portal/Overlay nesting, width variants, maximum dimensions, scroll areas, focus behavior and z-index 100. No additional close button is inserted. |
| `shared/ui/dropdown-menu.tsx` | Upstream popover border and menu styling; retain events, alignment, offsets, exports and z-index 110. |
| `shared/ui/card.tsx`, `badge.tsx`, `skeleton.tsx` | Upstream surfaces and styles; retain semantic HTML, compact dimensions, existing exports and success/warning badge variants. |
| `shared/ui/toast.tsx`, `empty-state.tsx` | Existing HardwareHarness components. Toast only adopts the neutral surface/border; its four-item capacity, 4/6-second timers, copy and dismiss behavior are unchanged. EmptyState remains unchanged. |
| `styles/tokens.css` | Exact official neutral core colors mapped to existing `--tf-*` names. Base radius is 0.625rem, with standard shadcn small/medium/large/xlarge offsets. Existing success/warning colors remain semantic; canvas and wire colors derive from neutral tokens. |

The registry's `cn` import is replaced with the existing local `clsx` /
`tailwind-merge` helper. No new runtime dependency is required. Existing Geist
fonts, theme persistence and `data-theme` switching are retained.

The application deliberately does **not** import Tailwind Preflight or
`shadcn/tailwind.css`. Its existing typography and spacing reset is preserved.
Button color/background/border resets live in the earlier theme layer so they
do not suppress the component variants. Adapted controls specify their own solid border.
The renderer's minimum dimensions, page layout, data operations and third-party
runtime behavior are outside this component adapter change.

## Behavior verification

`apps/desktop/src/test/shared-ui.test.tsx` exercises:

- Native Select empty selection, option groups, disabled options, refs and form data.
- React Hook Form registration and reset.
- Button default/submit types, refs, disabled state and Slot event composition.
- Checkbox false/true/indeterminate values and label activation.
- Nested Dialog Portal placement, Escape order and focus restoration.
- Toast capacity, ordinary/error durations, copying and manual dismissal.

The six adapter tests and the existing Devices editor / WiringTaskModal tests
pass together (nine assertions-based test cases). The full application gates
and visual review are run separately by the main implementation task.

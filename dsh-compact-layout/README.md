# dsh-compact-layout

Adds a whale display button in DSH's top-left overlay.

- **Focus layout** hides the left sidebar and details pane so chat uses the full viewport. It defaults on for screens at most 700 px wide and remembers the choice.
- **Text size** offers 80%, 90%, 100%, 110%, and 120% presets and remembers the choice. Composer text remains at least 16 px to prevent iPhone Safari's input-focus zoom.
- **Full screen** uses the browser Fullscreen API where available. iPhone Safari may retain its browser chrome unless DSH is launched as a Home Screen web app; focus layout still reclaims the DSH sidebar space.

The plugin occupies the additive `shell.overlay` slot. It does not replace DSH's root, sidebar, conversation, or attachment slots.

Install into the web profile:

```powershell
dsh plugin --profile web add G:\llmhub\integrations\dsh\dsh-compact-layout
```

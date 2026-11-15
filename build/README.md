# App icon and signing assets

Nothing in this folder is required to build; electron-builder falls back to the
default Electron icon with a warning. To brand the app, add:

- `icon.png` — 1024×1024 PNG (Linux, and the source for the others)
- `icon.icns` — macOS (`iconutil -c icns icon.iconset`)
- `icon.ico` — Windows (multi-size, 16–256px)

Keep the artwork on the same visual system as the LetsRunFaster site: a flat
mark on `#0b0e14`, with `#f95721` as the accent. Avoid the rounded-square
app-tile baked in for macOS — Apple masks it and double-rounding looks wrong.

Signing assets (not committed):

- macOS: `entitlements.mac.plist` plus a Developer ID Application certificate
  and notarization credentials in CI secrets.
- Windows: an Authenticode certificate (or Azure Trusted Signing) in CI.

Until those exist, installers work for development and for users who bypass
Gatekeeper/SmartScreen warnings.

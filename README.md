# pi-sub-limits

Pi extension that replaces the footer with session statistics, active-model details, subscription quota bars, and OpenCode Zen’s remaining prepaid balance. `/limits` refreshes the data and shows the same values in a notification.

Supported sources:

- OpenAI Codex OAuth: primary and secondary usage windows
- Anthropic OAuth: 5-hour, 7-day, and Opus windows
- Cursor: first-party model pool usage, opt-in
- OpenCode Zen: remaining USD balance, opt-in

Provider requests time out after ten seconds. The extension reads Pi’s local `auth.json` but never writes or refreshes credentials.

## Install

As a Pi package:

```sh
pi install git:github.com/elijah-rou/pi-sub-limits
```

For a development checkout linked directly into Pi:

```sh
git clone https://github.com/elijah-rou/pi-sub-limits.git ~/Projects/pi-sub-limits
mkdir -p ~/.pi/agent/extensions
ln -s ~/Projects/pi-sub-limits/sub-limits.ts ~/.pi/agent/extensions/sub-limits.ts
```

Run `/reload` in Pi after installing or updating the extension.

## Browser-backed providers

Cursor and Zen are disabled by default because they read authenticated browser cookies. On Linux they require `sqlite3`, `secret-tool`, and a logged-in Chromium, Google Chrome, or Helium profile. Cookie databases are opened read-only.

Enable Cursor with either:

```sh
export PI_SUB_LIMITS_CURSOR=1
# or
mkdir -p ~/.pi/agent && touch ~/.pi/agent/cursor-limits.enabled
```

Enable Zen with either:

```sh
export PI_SUB_LIMITS_ZEN=1
# or
mkdir -p ~/.pi/agent && touch ~/.pi/agent/zen-limits.enabled
```

An explicit non-empty environment value takes precedence over its marker. Set it to `0` to disable that source.

Zen does not currently expose remaining balance through the model API key. The extension sends only the `auth` or `__Host-auth` cookie to `https://opencode.ai`, blocks redirects, and parses the authenticated workspace billing payload. Override workspace discovery when needed:

```sh
export PI_SUB_LIMITS_ZEN_WORKSPACE=wrk_...
```

The dashboard’s server-function protocol is undocumented and may change. `/limits` reports a bounded error instead of hiding failures.

## Development

```sh
npm ci
npm run check
```

## License

MIT. See [NOTICE.md](NOTICE.md) for technical references.

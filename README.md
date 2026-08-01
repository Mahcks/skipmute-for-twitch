# SkipMute for Twitch

Browser extension for skipping Twitch VOD sections muted by Twitch Audio Recognition.

## Features

- Inline Twitch player control near the right-side player buttons.
- Automatic skip when playback reaches a detected muted segment.
- Progress badge showing muted segments passed over total muted segments.
- Undo after every automatic skip.
- Skip action after Undo so long muted sections can be re-skipped when the user is ready.
- Metadata-first detection with timeline-marker fallback.
- Optional official Twitch Helix API credentials.
- Optional silence fallback for edge cases.

## Browser Targets

- Firefox: `manifest.json` uses Manifest V2. Mozilla continues to support MV2.
- Chrome: `manifest.chrome.json` uses Manifest V3, which is required for Chrome publishing.

## Local Testing

### Firefox

1. Open `about:debugging#/runtime/this-firefox`.
2. Click **Load Temporary Add-on**.
3. Select `manifest.json`.
4. After edits, click **Reload** beside the temporary add-on and refresh the Twitch VOD tab.

### Chrome

1. Run `npm run package:chrome`.
2. Open `chrome://extensions`.
3. Enable Developer mode.
4. Click **Load unpacked**.
5. Select `dist/chrome`.

## Packaging

```powershell
npm run check
npm run package:firefox
npm run package:chrome
```

Outputs:

- `dist/twitch-vod-muted-skipper-firefox.zip`
- `dist/twitch-vod-muted-skipper-chrome.zip`

## Detection Sources

The extension tries detection in this order:

1. Official Twitch Helix API, if the user adds their own Client ID and OAuth bearer token.
2. Twitch web metadata, best effort.
3. Twitch player timeline markers, read from the red muted ranges in the seekbar.
4. Optional silence fallback, disabled by default.

## Privacy

See [PRIVACY.md](PRIVACY.md). The extension does not collect analytics, run remote code, or send data to non-Twitch services.

## Publishing Checklist

- Capture store screenshots listed in [STORE_LISTING.md](STORE_LISTING.md).
- Review permissions rationale in [STORE_LISTING.md](STORE_LISTING.md).
- Run `npm run check`.
- Package both browser builds.
- Test on at least one VOD with visible red muted timeline markers.

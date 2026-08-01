# Store Listing Draft

## Name

SkipMute for Twitch

## Add-on URL

skipmute-for-twitch

## Short description

Skip Twitch VOD sections muted by audio recognition, with undo and manual re-skip controls.

## Full description

SkipMute for Twitch adds a compact control to Twitch VOD players and automatically skips sections that Twitch has muted because of audio recognition.

Features:

- Detects muted VOD sections from Twitch metadata and visible timeline markers.
- Skips muted sections automatically when playback reaches them.
- Shows skipped/passed muted segment progress.
- Provides Undo after every automatic skip.
- After Undo, shows Skip so you can jump past that same muted section again when ready.
- Includes a settings page for metadata sources and optional advanced fallback behavior.

The extension runs only on Twitch VOD pages and stores settings locally in your browser.

## Permissions rationale

- `storage`: saves user settings.
- `https://www.twitch.tv/*`: reads Twitch VOD player state and injects the player control.
- `https://gql.twitch.tv/*`: attempts to load muted segment metadata from Twitch's web metadata endpoint.
- `https://api.twitch.tv/*`: optional official Twitch Helix metadata lookup when the user provides their own Twitch API credentials.

## Firefox data collection disclosure

The Firefox manifest declares `browsingActivity` because the extension may send the current Twitch VOD ID, derived from the active Twitch VOD page, to Twitch metadata endpoints. The extension developer does not receive or store this data.

## Screenshots to capture before publishing

- Twitch VOD with the inline player control near Clip/settings.
- Skip toast with Undo.
- Manual watch mode after Undo with Skip action visible.
- Settings page.

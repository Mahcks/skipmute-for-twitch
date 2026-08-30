# Store Listing Draft

## Name

SkipMute for Twitch

## Add-on URL

skipmute-for-twitch

## Short description

Skip Twitch VOD sections muted by audio recognition, with undo and manual re-skip controls.

## Full description

SkipMute for Twitch adds a compact control to Twitch VOD players and automatically skips sections that Twitch has muted because of audio recognition.

No Twitch login, Client ID, token, or setup is required. The default timeline mode works for logged-out viewers and keeps detection local to the page.

Features:

- Detects muted VOD sections from the official Twitch API or audio-confirmed timeline markers.
- Skips muted sections automatically when playback reaches them.
- Shows skipped/passed muted segment progress.
- Provides Undo after every automatic skip.
- After Undo, shows Skip so you can jump past that same muted section again when ready.
- Includes a settings page for official API credentials and timeline verification tuning.

The extension activates its player control only on Twitch VOD pages. The optional OAuth token stays in local browser extension storage; non-sensitive settings may use browser sync.

## Permissions rationale

- `storage`: saves user settings.
- `https://www.twitch.tv/*`: reads Twitch VOD player state and injects the player control.
- `https://api.twitch.tv/*`: optional official Twitch Helix metadata lookup when the user provides their own Twitch API credentials.

## Firefox data collection disclosure

The Firefox manifest declares no required data transmission. It declares optional `authenticationInfo` and `browsingActivity` because, only when a user configures the Helix integration and grants consent, the extension sends the user-provided token and current VOD ID to Twitch. The extension developer does not receive or store this data.

## Screenshots to capture before publishing

- Twitch VOD with the inline player control near Clip/settings.
- Skip toast with Undo.
- Manual watch mode after Undo with Skip action visible.
- Settings page.

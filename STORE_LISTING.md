# Store Listing Draft

## Name

SkipMute for Twitch

## Add-on URL

skipmute-for-twitch

## Short description

Skip Twitch VOD sections muted by audio recognition, with undo and manual re-skip controls.

## Full description

SkipMute for Twitch adds a compact control to Twitch VOD players and automatically skips sections that Twitch has muted because of audio recognition.

No Twitch login, Client ID, token, or setup is required. The default lookup reads Twitch's muted VOD metadata anonymously, without account cookies or credentials.

Features:

- Detects muted VOD sections from Twitch's GraphQL metadata, the optional official API, or audio-confirmed timeline markers.
- Skips muted sections automatically when playback reaches them.
- Shows skipped/passed muted segment progress.
- Provides Undo after every automatic skip.
- After Undo, shows Skip so you can jump past that same muted section again when ready.
- Includes a settings page for official API credentials and timeline verification tuning.
- Verifies audio without rerouting the player's sound and explains when verification is unavailable.

Timeline mode waits for confirmed silence inside a recognized muted marker. It does not automatically seek while playback is paused, buffering, or seeking, or when user mute or zero volume prevents confirmation. Optional API credentials are checked before saving, with clear errors for invalid tokens or mismatched Client IDs.

The extension activates its player control only on Twitch VOD pages. The optional OAuth token stays in local browser extension storage; non-sensitive settings may use browser sync.

SkipMute for Twitch is not affiliated with or endorsed by Twitch.

## Permissions rationale

- `storage`: saves user settings.
- `alarms`: revalidates optional API credentials hourly while configured and permitted.
- `https://www.twitch.tv/*`: reads Twitch VOD player state and injects the player control.
- `https://gql.twitch.tv/*`: anonymous muted metadata lookup using the current VOD ID.
- `https://api.twitch.tv/*`: optional official Twitch Helix metadata lookup when the user provides their own Twitch API credentials.
- `https://id.twitch.tv/*`: validates the optional OAuth token during setup, startup, and scheduled checks.

## Firefox data collection disclosure

The Firefox manifest declares required `browsingActivity` because the default anonymous GraphQL lookup sends the current VOD ID to Twitch. It declares optional `authenticationInfo` for user-provided Helix credentials, which are sent only after consent. No account cookies or credentials are sent with GraphQL requests. The extension developer does not receive or store this data.

## Store screenshots

- Twitch VOD with the inline player control near Clip/settings.
- Skip toast with Undo.
- Manual watch mode after Undo with Skip action visible.
- Settings page.

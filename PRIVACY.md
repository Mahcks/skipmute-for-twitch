# Privacy Policy

SkipMute for Twitch does not collect, sell, or store personal data on external servers controlled by the extension developer.

The extension loads on Twitch pages so it can follow Twitch's client-side navigation, but activates its control only on VOD pages. It reads the active VOD player state and requests muted intervals from Twitch's GraphQL endpoint at `gql.twitch.tv`, sending the current VOD ID and Twitch's public web client identifier. This default query omits cookies and account credentials. Firefox declares browsing-activity transmission as required for this lookup. When metadata lookup fails, timeline markers and playback audio are analyzed locally. Settings are stored in the browser's extension storage.

If you add optional Twitch Helix API credentials in the settings page, the OAuth token is stored only in local browser extension storage. With API access permitted, the token is sent to `id.twitch.tv` to validate credentials during setup, on extension startup, and hourly while configured. The token and current Twitch VOD ID are sent to `api.twitch.tv` when loading VOD metadata. Token validation does not send a VOD ID. Other non-sensitive settings may use browser sync. Firefox asks for optional authentication-information consent before the token is sent; browsing-activity transmission is already declared as required. Removing the token or its authentication consent stops scheduled validation and leaves the anonymous metadata lookup available.

Tokens saved by older versions in browser sync are migrated automatically to local storage. Migration preserves an existing local token and removes the synced copy only after successful local storage. Users of a version that synced tokens can rotate their Twitch token to invalidate previously replicated copies.

The extension does not include analytics, advertising, remote code execution, or third-party tracking.

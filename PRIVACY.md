# Privacy Policy

SkipMute for Twitch does not collect, sell, or store personal data on external servers controlled by the extension developer.

The extension loads on Twitch pages so it can follow Twitch's client-side navigation, but activates its control only on VOD pages. It reads the active VOD player state and muted timeline markers locally so it can skip muted sections. Settings are stored in the browser's extension storage. This default mode does not transmit data outside the browser.

If you add optional Twitch Helix API credentials in the settings page, the OAuth token is stored only in local browser extension storage. The token and current Twitch VOD ID are then sent only to Twitch API endpoints when loading VOD metadata. Other non-sensitive settings may use browser sync. Firefox asks for optional authentication-information and browsing-activity consent before these values are sent.

The extension does not include analytics, advertising, remote code execution, or third-party tracking.

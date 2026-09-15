# SkipMute deep audit

Date: 2026-09-14. Original audited revision: `793c826` (version 0.3.0).

## Remediation status

The user requested implementation of every finding. All nine findings and the audio-routing investigation have now been addressed in the working tree. The audit below is historical evidence of the original defects, not a description of the corrected code.

| Original finding | Implemented change |
| --- | --- |
| 01 — Browser verification | Deterministic real-media Chromium/Firefox suite; CI and release checks run it; live smoke now checks actual Skip/Undo/re-skip |
| 02 — False timeline markers | Markers must belong to Twitch's observed seekbar structure and use the correct percentage containing block |
| 03 — User mute | User mute/zero volume cannot confirm timeline silence; captured audio measurement is independent of output volume |
| 04 — Interrupted confirmation | Reset on pauses, buffering, seeking, disabling, source/segment changes, and discontinuous playback |
| 05 — Stale VOD identity | Strict page identity checks at metadata completion and every seek; source replacement invalidates stale timeline/action state |
| 06 — User scrubbing | Ordinary skips no longer retry; narrowly scoped Undo recovery is canceled by independent user input |
| 07 — Firefox consent | Explicit Save API credentials action requests consent synchronously before queued persistence |
| 08 — Audio precision | Native floating-point samples replace byte-quantized measurements |
| 09 — Legacy token migration | Background owns migration at startup/before reads; options await it before saving/resetting; failures preserve the synced token |
| Audio-routing investigation | Capture audio without rerouting native playback; release captures on replacement/failure; reject unverified cross-origin media |

The three direction suggestions are also covered: the browser suite reports case counts and latency; the control tooltip explains unavailable audio verification; optional credentials are validated before saving and periodically, with actionable errors. Privacy/store documentation reflects the validation endpoint and scheduled requests.

Verification: 28 unit tests pass; across Chromium and Firefox, 12 no-skip cases and 6 expected automatic skips pass with zero false/missed skips in this controlled corpus. Undo/re-skip and replacement/reuse pass. Chromium runs an installed temporary extension; Firefox uses production content initialization with stubbed extension APIs. A packaged Chrome build also passed Skip → Undo → re-skip on live Twitch VOD `1766753076`.

Browser tests now silence device output using Chromium's mute-output flag and Firefox's output-volume preference, without muting captured audio. The final complete browser run passed with these settings; an isolated audio loopback measured 1,631,698 samples, all zero. The temporary silent sink was removed afterward and the user's default output was unchanged. Both ZIP archives pass integrity checks; Firefox packaging lint reports zero errors, warnings, or notices. Dependency audit reports zero vulnerabilities.

Remaining verification limits: no real OAuth credential was supplied, the actual Firefox consent dialog was not exercised, and minimum historical browser releases were not run. Synthetic case counts and one live VOD are not a universal accuracy percentage or a competitor benchmark. No extension was published.

## Original audit

## Verdict

The extension has a small, dependency-free implementation and useful Undo controls, but its current checks do not establish accurate skipping. Reproduced failures affect detection, silence confirmation, and user control. Do not claim 100% accuracy or best-in-class reliability from this baseline.

Three parallel agents reviewed playback correctness; browser/API/security integration; and reliability/tests/packaging. The primary reviewer read the cited implementation, deduplicated findings, reran checks, and performed additional Chromium experiments. No extension source was changed. This is an audit, not an executed remediation plan.

## Verification and scope

- `npm run check`: PASS, all 9 tests plus JavaScript syntax checks.
- Read all runtime JS, HTML/CSS, both manifests, tests, packaging/live-smoke scripts, workflows, README, privacy and store copy. Reviewed recent git history.
- Ran ephemeral Node VM checks against the existing content test harness. Confirmed pause/resume skips immediately and a delayed retry overrides a deliberate scrub. The correctness agent separately reproduced stale-VOD seeking.
- Ran installed headless Chromium with local fixtures and the real content-script functions, exposed only in memory. Confirmed unrelated red-element detection and analyser behavior with a generated, audible 440 Hz WAV. These were browser API/function tests, not a fully installed extension end-to-end test.
- Checked official Mozilla, Twitch and Web Audio documentation where platform behavior mattered.
- Did not run live Twitch playback, logged-in/API credential flows, the actual Firefox consent dialog, store installation, packaged extension playback, historical minimum browser versions, competitor benchmarks, or performance profiling. Packaging/CI were inspected, not republished or deployed. Binary art was not visually audited. No dependency vulnerability scan was necessary for the dependency-free runtime; CI tooling was reviewed but not exhaustively vulnerability-audited.

## Prioritized findings

P1: address before making a strong reliability claim. P2: important follow-up. S: hours including regression checks; M: roughly a day or more depending on browser verification. Risk is the risk of changing the code, not the impact of leaving the defect.

| ID | Priority | Finding | Category | Impact | Effort | Fix risk | Confidence | Evidence |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 01 | P1 | Test real playback | Tests | Current checks miss the core failure modes | M | Low | High | `scripts/live-smoke.cjs:21`, `test/extension.test.js:15` |
| 02 | P1 | Restrict marker detection to the actual timeline | Correctness | Unrelated red UI can become a whole-VOD muted range | M | Medium | High, Chromium fixture | `content.js:231`, `content.js:238`, `content.js:296` |
| 03 | P1 | Do not treat user mute as source silence | Correctness | User audio controls invalidate the confirmation safeguard | S | Low | High, Chromium fixture | `content.js:197`, `content.js:418`, `content.js:430` |
| 04 | P1 | Reset silence confirmation across interruptions | Correctness | Pause/seek/disable time can count as confirmed playback | S | Low | High, VM reproduction | `content.js:182`, `content.js:199` |
| 05 | P1 | Reject stale VOD identity before seeking | Correctness | Old muted ranges can seek a new VOD | S | Low | High for reproduced state; live frequency unverified | `content.js:95`, `content.js:171`, `content.js:844` |
| 06 | P2 | Preserve deliberate scrubbing during seek recovery | Correctness | Retry can override the user's destination | M | Medium | High, VM reproduction | `content.js:393`, `content.js:400`, `content.js:407` |
| 07 | P2 | Request Firefox consent within a user action | Platform | Fresh optional API setup cannot reliably obtain consent | S | Low | High from code/docs; dialog not exercised | `options.js:25`, `options.js:134` |
| 08 | P2 | Use floating-point audio samples | Correctness | Quantization distorts configurable silence thresholds | S | Low | High, math plus Chromium measurement | `content.js:439`, `content.js:449` |
| 09 | P2 | Migrate legacy tokens without opening settings | Security/upgrade | Legacy synced secrets persist and API setup stops working | S | Medium | High code confidence; population conditional | `options.js:103`, `background.js:7` |

### 01 — Verification does not exercise skipping in a browser

The live smoke script aborts media requests and asserts only that a control and segment count appear. Its success message establishes marker detection, not audio confirmation, seeking, or Undo. The unit harness uses an always-running mock AudioContext, a DOM with no overlay, and bypasses production initialization through the test hook.

Add one deterministic browser scenario with known audible/silent media and timeline markup. Exercise production initialization, audible non-skips, muted skips, Undo/re-skip, replacement/navigation, and user audio controls. Run on Chromium and Firefox. Keep the existing live canary as a separate Twitch DOM compatibility check. This verification should precede risky audio/lifecycle changes; focused failing regressions can accompany the small fixes.

### 02 — Red elements bypass timeline validation

`extractTimelineMutedSegments()` accepts a matching red background/border immediately when percentage positioning can be parsed. That return occurs before its size/location checks. The element need not belong to a seekbar. The bounding-box fallback is also broad: its purported bottom-controls check accepts elements throughout the video's vertical area.

Chromium fixture: a generic `.player` contained a video with duration 1000 and an unrelated red overlay with `left: 0%`, `width: 100%`, and height 80px. Extraction returned `{offset: 0, duration: 1000, end: 1000}`. This establishes a false-candidate defect; it does not establish that current Twitch renders that exact overlay.

Locate and validate the active VOD seekbar before examining markers, including the percentage-style path. Require marker ancestry/semantics and verify percentage coordinates relative to the real track. Test unrelated red UI, hidden controls, and nested percentage containers. Preserve logged-out operation; replacing this with mandatory API credentials would discard the product's primary benefit.

### 03 — Player mute becomes a false silence confirmation

The analyser receives the media element's output, and the skip path never excludes `video.muted` or zero volume. Chromium with a generated audible WAV measured RMS about `0.25847` at normal volume and exactly `0` after setting `video.muted = true`. The default silence threshold is `0.004`, so user mute satisfies the condition even though the underlying recording is audible.

This does not cause skipping outside a candidate segment. It removes the safeguard against inaccurate candidates such as finding 02. Fail closed when user mute or zero volume prevents source verification, resetting any accumulated confirmation. Explicitly define low-volume behavior; this analyser observes output loudness, so its reading is not independent of volume.

### 04 — Interrupted playback still satisfies the timer

Eligibility guards return before clearing `timelineMuteStartedAt`. The timer measures elapsed wall time and is not tied to a particular segment or continuously progressing playback.

VM reproduction: timeline range 100–200; one silent tick at performance time 1000ms; pause until 10000ms; resume and tick once. Playhead immediately becomes `200.35`. No continuous 1.5 seconds of silent playback was observed.

Clear/restart confirmation on pause, seeking, disabling, suppression, video/segment changes, and loss of playback progress. Add pause/resume and seek-between-segments regressions. Checking `readyState`/progress should also stop buffering from being interpreted as silence.

### 05 — URL polling leaves an identity gap

Navigation hydration polls every 700ms, while playback ticks run every 500ms. A tick may refresh the video element but still use the old `videoId` and segments. Playback mutations never check current URL identity.

Agent VM reproduction: state for VOD 123 with range 5–20; current URL switched to VOD 999; playhead at 10. Before hydration, `tick()` seeks to `20.35`. Actual Twitch element-replacement timing was not measured.

Validate page identity immediately before automatic and manual seeks, invalidate outstanding retries when identity changes, and clear segment-specific state when replacing the media source. Test both reused and replacement video elements. A wholesale navigation framework is unnecessary.

### 06 — Seek correction cannot distinguish user intent

The retry treats proximity to the original playhead as proof that Twitch overwrote the seek. A user scrub does not increment the extension's `seekId`.

Reproduced through the existing harness: auto-skip from 10 to `20.35`; user returns to 10; run the scheduled retry. The playhead is forced to `20.35` again. The `seeked` listener can apply the same correction earlier.

Cancel or disambiguate retries when independent player input changes the destination. Preserve the existing Undo-overwritten-by-an-older-seek case; simply deleting recovery would lose that protection. Verify both behaviors together.

### 07 — Firefox permission request happens after async work

Token handling is deferred through `pendingSave.then(...)`; permission checks then await `getAll()` before calling `permissions.request()`. Mozilla documents that waiting on a promise loses the user-action context needed for this API. The existing permission mock always grants the request and cannot catch it. [Mozilla user actions](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/User_actions)

Prepare permission state before the interaction and initiate any request directly from an explicit user action. Keep storage writes serialized after consent. Check fresh grant, refusal, already-granted state, and token replacement in actual Firefox. No dialog was exercised during this audit, so that remains an acceptance gate.

### 08 — Byte audio samples are too coarse for the threshold

The byte conversion has increments of `1/128 ≈ 0.0078125`, while the default threshold is `0.004`. A tiny symmetric waveform can quantize to 127/128 and produce calculated RMS around `0.00552`, despite much lower true RMS.

Chromium measured about `0.00556` for the generated WAV at 1% volume; expected unquantized RMS is approximately `0.00259`. This is a quantization problem independent of the user-mute issue.

Use the native `getFloatTimeDomainData()` with `Float32Array` and compute RMS directly. Test true zero and waveforms above/below the threshold. This improves measurement precision; it does not prove that silence means Twitch Audio Recognition muting.

### 09 — Legacy credential migration only runs in options

The options page contains explicit migration from synced to local OAuth storage. Background metadata loading reads only local storage. An upgrading user who never opens options therefore retains the synced credential and loses API detection.

Move or reuse the idempotent migration in a background path reached on update/startup or before metadata loading. Preserve an existing local token; only delete the synced copy after successful local persistence. Test both legacy-only and conflicting local/synced values, including storage failure. If a token-syncing release reached users, recommend rotation of affected tokens because deletion does not reverse earlier replication. No real credential value was discovered or copied during this audit.

## Additional investigation: audio routing can affect playback

Evidence: `content.js:429` creates an AudioContext and binds the video before checking whether it is running. `content.js:848` closes and forgets the context when the selected video changes.

Media source creation reroutes audio through Web Audio. Suspended contexts can interrupt output; CORS-restricted sources must emit silence. The latter can both remove audio and resemble a positive silence reading. These are platform conditions, not a demonstrated failure on current Twitch streams. [Chrome autoplay policy](https://developer.chrome.com/blog/autoplay), [Web Audio specification](https://www.w3.org/TR/webaudio-1.0/)

A separate Chromium test confirmed that creating a source for a video, closing that context, then binding the same video to a new context throws `InvalidStateError`. Thus selecting A, then B, then the same A cannot recover by the present close-and-recreate strategy. Whether Twitch currently reuses detached elements this way needs observation.

Impact: potentially broken sound or permanently unavailable timeline confirmation. Effort: M. Fix risk: high because the extension is inside the playback audio graph. Confidence: high on platform behavior, medium on current Twitch exposure. Investigate fresh autoplay, source replacement/reuse, cross-origin media, and audio-extension coexistence in a browser fixture and live Twitch before choosing a minimal lifecycle change. Do not assume disconnecting or closing a source restores native audio routing.

## Product direction, separate from defects

1. **Make accuracy measurable.** Build a small labeled corpus of muted and unmuted intervals covering logged-out use, multiple playback speeds, navigation, hidden controls, user mute, and different VOD lengths. Report false skips separately from missed muted intervals and skip latency. The current nine tests and DOM-only canary provide no denominator for an accuracy claim. A controlled fixture is reproducible; live VOD checks catch Twitch drift but can disappear. Use both.
2. **Expose why skipping is unavailable.** `getAudioLevel()` silently returns null, while `renderOverlay()` can still say “timeline markers.” A compact status explaining unavailable audio verification or a rejected candidate would make failures understandable without adding a dashboard. Avoid suggesting that “enabled” guarantees active verification.
3. **Make optional API setup verifiable.** `options.js:39` says Saved after persistence; `background.js:23` only surfaces an HTTP status. Add explicit valid/expired/mismatched-client feedback if this integration remains supported. Twitch documents startup/hourly validation for apps maintaining OAuth sessions; determine how the manually supplied-token design fits that model before adding a validation lifecycle and new host permissions. [Twitch token validation](https://dev.twitch.tv/docs/authentication/validate-tokens/)

## Suggested order and retained decisions

First establish the real-browser regression fixture (01), then fix false candidate/silence behavior (02–04) and page identity (05). Verify audio routing before claiming safe default detection. Follow with seek intent (06), Firefox consent (07), sample precision (08), and upgrade migration (09). Consent and migration are independent of playback work and can run alongside it.

Keep the dependency-free runtime, local default detection, background-only network credential use, native controls, Undo/re-skip, and separate browser manifests. No evidence justified a framework migration, broad module split, new runtime dependency, replacement of all polling with observers, or a speculative performance rewrite. The root `innerHTML` is a static template, not an identified injection vulnerability. Local token storage is intentional; the defect is the incomplete legacy migration. Duplicate pause/timer and test-coverage findings from agents were merged. The external canary's potential deletion is already documented and is not an additional newly discovered bug.

No implementation plans were selected or executed. This file records the vetted audit and recommended order.

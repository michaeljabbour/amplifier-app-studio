# Windows, Android, and iOS certification

This file distinguishes source readiness from signed, store-certified, and
published releases. A green build is not certification.

## Recommended distribution paths

- **Windows:** ship an MSIX through Microsoft Store. The Store provides package
  hosting, signing, installation, and updates without an Azure Artifact Signing
  subscription or a commercial PFX. GitHub Releases also carry compiled x64
  EXE/MSI evaluation installers, but they must be labeled unsigned and are not
  a substitute for a Store-certified or Authenticode-signed release.
- **Android:** ship an Android App Bundle through Google Play with Play App
  Signing enabled. Google holds the app-signing key; CI uses a separate upload
  key that can be replaced if compromised.

## Windows release gate

The **Build Windows Store package** workflow builds the unpackaged Tauri
executable, wraps it as an intentionally unsigned MSIX with Microsoft's WinApp
CLI, verifies its identity and payload, and retains it as a workflow artifact.
Microsoft Store applies the public signature during submission processing.

Configure these exact Partner Center Product identity values as GitHub
`release` environment variables (not secrets):

- `WINDOWS_STORE_IDENTITY_NAME`;
- `WINDOWS_STORE_PUBLISHER_ID` (the complete `CN=...` value);
- `WINDOWS_STORE_PUBLISHER_DISPLAY_NAME`.

Before Store submission:

1. Create or confirm the Microsoft Partner Center account and reserve
   **Amplifier Studio**.
2. Copy all three Product identity values into the protected GitHub environment.
   Do not guess or derive them from the product name.
3. Run **Build Windows Store package**, download the MSIX artifact, and upload
   it to the app submission. Do not sideload the unsigned artifact.
4. On a clean supported Windows machine, test silent install, ordinary install,
   first launch, WebView2 startup, remote-host pairing, session resume, update,
   and uninstall.
5. Complete Store identity, age rating, privacy, support URL, screenshots, and
   certification notes. Explain that compute runs on the paired remote host.
6. Give certification testers a dedicated, always-available demo host and test
   credentials. A reviewer cannot be expected to join a private personal
   tailnet, and Microsoft may reject an app whose required server cannot be
   reached during certification.

Trusted direct web distribution of EXE/MSI installers needs a separately funded
Authenticode identity. The unsigned GitHub evaluation artifacts prove the
tagged x64 build exists; they do not prove publisher identity, clean-machine
installation, or Windows certification. That optional trust channel must not
block the free Store channel or the macOS release.

## Android release gate

The generated Android project targets API 36 and requires API 24 or newer. Its
release build now fails when upload-key signing is absent. Android TV launcher
metadata was removed because the current product is a phone/tablet client.

Create an RSA 2048-bit-or-stronger upload key once, store the only recoverable
backup securely, and add these GitHub `release` environment secrets:

- `ANDROID_UPLOAD_KEYSTORE_BASE64`;
- `ANDROID_UPLOAD_KEYSTORE_PASSWORD`;
- `ANDROID_UPLOAD_KEY_ALIAS`;
- `ANDROID_UPLOAD_KEY_PASSWORD`.

The **Publish Android internal build** workflow builds a signed `.aab`, verifies
its JAR signature, retains it as a workflow artifact, authenticates with Google
through GitHub OIDC, and commits the bundle to the configured Play track. The
service account still needs an app-level Play Console grant before that API
call can succeed.

Before Play submission:

1. Create or confirm the Play Console developer account and create
   `com.amplifier.studio`.
2. Enroll the app in Play App Signing, keeping the upload key separate from the
   Google-managed app-signing key.
3. Upload the verified AAB to Internal testing first.
4. Complete App access instructions, Data safety, privacy policy, content
   rating, ads declaration, target-audience declaration, support details, store
   copy, icon, feature graphic, phone screenshots, and tablet screenshots if the
   app is offered on tablets.
5. Disclose microphone permission usage and verify the app behaves correctly
   when microphone access is denied.
6. Test install, launch, remote-host enrollment, reconnect/resume, background
   and foreground transitions, keyboard/composer behavior, file attachment,
   microphone permission, and uninstall on a physical Android phone.
7. Supply a reusable review account and dedicated demo host that work from any
   reviewer location without one-time codes. Do not provide a production user's
   account or require access to a personal tailnet.

## iOS TestFlight gate

The iOS workflow imports Apple Development and Apple Distribution identities,
the App Store provisioning profile for `com.amplifier.studio`, and a team App
Store Connect API key. Tauri development-signs its first device build, then the
App Store export re-signs the IPA with Apple Distribution. The workflow
validates the exported IPA before upload and adds the processed build to the
configured TestFlight group through the App Store Connect API.

Configure the Apple secrets and `IOS_TESTFLIGHT_GROUPS` described in the
README. The API issuer UUID and exact group names must come from App Store
Connect; they must not be guessed from the key filename or tester email
addresses.

Before claiming TestFlight delivery, verify the workflow upload, Apple's build
processing state, group assignment, and an actual tester installation as four
separate states.

## Evidence states

- **Built:** compilation produced an installer or AAB.
- **Signed:** signature verification passed with the intended release identity.
- **Store uploaded:** the artifact is present in Partner Center or Play Console.
- **Certified:** the store review/certification passed.
- **Published:** the approved listing is available to its intended audience.

## Current Android build evidence (2026-08-18)

A local release build completed from this checkout and produced
`src-tauri/gen/android/app/build/outputs/bundle/universalRelease/app-universal-release.aab`.

- version name: `0.1.38`
- version code: `1038`
- application ID: `com.amplifier.studio`
- minimum SDK: 24
- target SDK: 36
- AAB SHA-256: `54c38be3c4106f5eac80d53db26c7a3a639ac87d725224569da76a79ec3e4b44`
- `jarsigner` verification: passed
- upload signer SHA-256: `0E:D7:94:41:4B:E8:6E:04:0B:D9:6C:58:6D:F0:B6:5D:F1:13:E5:D3:F0:7D:B4:79:FA:CE:B6:5C:F5:AD:6D:4C`

This proves release compilation and upload-key signing, not Play upload or
Google-managed app signing. On this Mac, `/opt/homebrew/bin/rustc` precedes the
Rustup proxy; the Android build must run with `$HOME/.cargo/bin` first in
`PATH` so Rust can locate the installed Android standard library. GitHub's
Android workflow uses `dtolnay/rust-toolchain`, but the same toolchain-path
assertion should be added to release preflight to prevent a runner image change
from recreating this failure.

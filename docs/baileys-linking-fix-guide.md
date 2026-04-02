# Baileys v7 “Couldn’t Link Device” + Disconnect Fix Guide (for this repo)

This guide is specific to this project (`nipbang-kotaete`) and the failure pattern:

- QR is shown and scannable
- WhatsApp says **"couldn't link device"**
- daemon then disconnects/retries

It documents the exact hardening we applied in this repo and how to operate/debug it.

---

## 1) What this issue is (and is not)

### Symptom in scope

- Fails during pairing/link handshake (not after successful link)
- You may see rapid disconnect/reconnect loops after scan

### Not the same as GitHub issue #2441

- #2441 focuses on **463 reach-out timelock** (`tctoken`/`cstoken`) during send/call behavior **after** linking.
- Your failure happens at link/auth stage, so different root causes and fix path.

---

## 2) Root causes addressed here

For `@whiskeysockets/baileys@7.0.0-rc.9`, this repo now hardens against a specific handshake failure signature by combining:

1. **Client-side fingerprint tuning**
   - `browser: Browsers.macOS('Desktop')`
   - `syncFullHistory: true`

2. **Deterministic postinstall patching in node_modules**
   - `validate-connection.js`:
     - `passive: true` → `passive: false` (login node)
     - `lidDbMigrated: false` → `lidDbMigrated: true`
   - `socket.js`:
     - `await noise.finishInit();` → `noise.finishInit();`

3. **Auth state reset and fresh relink**
   - removes stale/invalid auth that can keep reconnecting into failure

4. **Exact version pinning**
   - pin Baileys to exact `7.0.0-rc.9` so patch targets remain stable

---

## 3) What changed in this repo

### `package.json`

- Baileys pinned to exact version:

```json
"@whiskeysockets/baileys": "7.0.0-rc.9"
```

- Added scripts:

```json
"postinstall": "bun run scripts/patch-baileys-linking.ts",
"baileys:patch:check": "bun run scripts/patch-baileys-linking.ts --check",
"daemon": "bun run baileys:patch:check && bun run src/cli/index.ts daemon"
```

This ensures:

- patch auto-applies after install
- daemon refuses to start if patch is missing

### `scripts/patch-baileys-linking.ts`

- Idempotent patcher + checker for:
  - `node_modules/@whiskeysockets/baileys/lib/Utils/validate-connection.js`
  - `node_modules/@whiskeysockets/baileys/lib/Socket/socket.js`

Modes:

- apply mode (default): patches then verifies
- check mode (`--check`): verifies only; exits non-zero if not patched

### `src/whatsapp/client.ts`

- Updated socket config:

```ts
browser: Browsers.macOS('Desktop')
syncFullHistory: true
```

---

## 4) Standard recovery flow (run this first)

From project root:

```bash
bun install
rm -rf ~/.kotaete/auth
bun run daemon
```

Then:

1. Scan QR from WhatsApp → Linked devices
2. Wait for daemon logs to show successful open

If link succeeds once, future daemon restarts should reuse persisted auth (unless session is invalidated remotely).

---

## 5) Validation commands

### Check patch status

```bash
bun run baileys:patch:check
```

Expected:

```txt
[baileys-patch] OK: linking patch present
```

### Full sanity check

```bash
bun run typecheck
bun run fmt
```

---

## 6) Troubleshooting matrix

### A) `baileys:patch:check` fails

Cause:

- Baileys updated or files changed, patch no longer matches

Action:

1. Reinstall exact version:
   ```bash
   bun add @whiskeysockets/baileys@7.0.0-rc.9
   bun install
   ```
2. Re-run check:
   ```bash
   bun run baileys:patch:check
   ```
3. If still failing, inspect `scripts/patch-baileys-linking.ts` patterns against installed Baileys source and update rules.

### B) QR scans, still “couldn’t link device”

Action order:

1. Ensure patch check passes
2. Delete auth dir and relink:
   ```bash
   rm -rf ~/.kotaete/auth
   bun run daemon
   ```
3. Verify linked-device slots available on your phone (remove old devices if needed)
4. Disable VPN/proxy temporarily on phone + host; retry
5. Ensure host clock is synced (NTP)

### C) Immediate disconnect loop after successful link attempt

Action:

1. Confirm daemon is started through script (`bun run daemon`) so patch check runs
2. Confirm auth dir is writable (`~/.kotaete/auth`)
3. Clear auth and relink once

### D) Works locally but fails on VPS/cloud IP

WhatsApp may be stricter on certain network profiles.

Action:

- Try from a residential/home network first
- Avoid aggressive VPN/proxy during initial link

---

## 7) Operational recommendations

1. Always start daemon via:

```bash
bun run daemon
```

Not via raw direct command, so patch check is enforced.

2. Keep Baileys version pinned while this patch strategy is in place.

3. If you intentionally upgrade Baileys:

- expect patch script maintenance
- run `baileys:patch:check` before runtime tests

4. Keep auth persistence folder stable (`~/.kotaete/auth`) and avoid manual edits inside it.

---

## 8) Quick checklist

- [ ] `@whiskeysockets/baileys` is exact `7.0.0-rc.9`
- [ ] `bun run baileys:patch:check` passes
- [ ] `browser = Browsers.macOS('Desktop')`
- [ ] `syncFullHistory = true`
- [ ] old auth removed once before relink
- [ ] link tested from `bun run daemon`

---

## 9) Why this guide is repo-specific

This project explicitly adopts deterministic patching + startup guardrails for this failure mode.
If upstream Baileys changes behavior/fixes this path, you can remove this patch workflow later and simplify.

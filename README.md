# Analyse Native Deployment

Checks, **before you deploy**, whether a new Mendix deployment package (`.mda`) will break native mobile apps that users already have installed.

A native app on a phone runs the JavaScript bundle it was shipped (or last OTA-updated) with. When the server is upgraded, that old bundle keeps talking to the new server and keeps using its local offline database. This tool compares the old package with the new one and reports what will fail for those users.

## What it checks

| Check | Source | Breaks when |
|---|---|---|
| **Server operations** | Old native bundle (Android + iOS) + `model/operations.json` | An operation ID the old app calls no longer exists on the new server (microflow call, retrieve, commit, delete, …). |
| **Operation access** | `model/operations.json` | An operation still exists but fewer user roles are allowed to call it. |
| **Offline schema** | `model/model.mdp` | An entity, attribute or association stored in the app's offline database is removed, renamed or changes type (Mendix offline-first best practices: *"Do not remove, rename, or change the type of entities or their attributes in offline apps after your initial release"*). |
| **Native dependencies** | `model/nativeDependencies.json` + `model/metadata.json` | Native modules differ, or the Mendix major version changes. The Native Template must then be updated and a new app built and released. An OTA update alone is not enough. |

## Requirements

- Node.js 16 or newer
- No `npm install` needed (no external dependencies)

## Quick start

1. Put the two deployment packages in `packages/`:
   ```
   packages/
     main-2.2.79.c2e3a5c4.mda   <- version currently installed on users' phones
     main-3.0.5.34b5cdfb.mda    <- version you want to deploy
   ```
2. Run:
   ```
   node tools/analyse-native-operations.js packages/main-2.2.79.c2e3a5c4.mda packages/main-3.0.5.34b5cdfb.mda
   ```
3. Open `reports/breaking-operations.md`.

The first argument is always the **old** version (what users have), the second the **new** version (what you deploy).

## Usage

```
node tools/analyse-native-operations.js <old> <new> [options]
```

`<old>` and `<new>` can each be:

- a `.mda` file: unpacked next to itself (`main-x.y.z.mda` → `main-x.y.z/`) the first time, then reused on later runs
- an already unpacked package folder (contains `model/operations.json`)
- a folder path that doesn't exist yet but has a matching `<folder>.mda` next to it: that file is unpacked

| Option | Default | Description |
|---|---|---|
| `--out <dir>` | `reports` | Folder for the report files (created if missing). |
| `--platform android\|ios\|all` | `all` | Which native bundles to scan for operation IDs. |
| `--force-extract` | off | Unpack the `.mda` again even if the folder already exists. |

### Examples

Compare the release on users' phones with the candidate release:
```
node tools/analyse-native-operations.js packages/main-2.2.79.c2e3a5c4.mda packages/main-3.0.5.34b5cdfb.mda
```

Write the report to a separate folder per comparison:
```
node tools/analyse-native-operations.js packages/main-3.0.4.b14e54bc.mda packages/main-3.0.5.34b5cdfb.mda --out reports/3.0.4-vs-3.0.5
```

Only scan the Android bundle:
```
node tools/analyse-native-operations.js packages/main-2.2.79.c2e3a5c4 packages/main-3.0.5.34b5cdfb --platform android
```

> Tip: if several app versions are still in use (check your app store statistics / OTA dashboards), run the tool once for **each** old version against the new one.

## Output

All files are written to the `--out` folder.

| File | Contents |
|---|---|
| `breaking-operations.md` | Full human-readable report. Start here. |
| `breaking-operations.json` | Everything in machine-readable form (summary + all findings). |
| `breaking-operations.csv` | Missing operations, one row each (opens in Excel). |
| `offline-schema.csv` | Offline schema findings. |
| `native-dependencies.csv` | Native dependency differences. |

### Reading the report

The report starts with a **verdict**:

- **NEW APP REQUIRED**: native dependencies (or the Mendix major version) differ. Update the Native Template, build a new app and release it through the app stores. Old installed apps cannot run the new bundle.
- **native dependencies match**: the new bundle can run on the installed app (OTA possible), as long as the sections below are clean.

Then, per check:

**Missing operations**

| Status | Meaning | What to do |
|---|---|---|
| `CHANGED` | The same logical operation exists in the new package, but with a new ID. The report lists the replacement ID and what changed in its definition. If nothing changed, the widget or action that calls it was probably recreated in the model. | Revert or restore the original element if you can, or accept that this function fails in old apps until they update. |
| `REMOVED` | No equivalent operation exists in the new package. | Keep the old page/microflow/widget in an in-between release, or force users to update. |

**Offline schema**

| Severity | Meaning |
|---|---|
| `BREAKING` | Entity/attribute/association removed, renamed or changed type; entity no longer stored offline (incl. switched to the Mendix 11 `Online` sync mode); persistable or generalization changed. Old apps may lose access to locally stored objects or values. |
| `WARNING` | Enumeration value removed, string length reduced, sync mode or constraint changed. Usually works, but check unsynced local data. |

The Mendix-recommended fix is an **in-between release**: ship a backwards-compatible version first, wait until all apps have synchronized, then make the breaking change in the next release.

**Native dependencies**

| Change | Meaning |
|---|---|
| `ADDED` | New native module. Not in the installed app; the new bundle crashes where it uses it. |
| `REMOVED` | No longer used. Remove it from the Native Template. |
| `VERSION` | Different version than in the installed app. The bump column shows major/minor/patch. |

Any row here means: **update the Native Template and release a new app**.

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Nothing breaks for old clients and native dependencies match. Safe to deploy (OTA possible). |
| `1` | Tool error (bad arguments, file not found, corrupt `.mda`). |
| `2` | At least one missing operation, breaking offline schema change, or new app required. |

Use this in a CI pipeline to block a deployment, for example:
```
node tools/analyse-native-operations.js "$PREVIOUS_MDA" "$NEW_MDA" --out reports || exit 1
```

## How it works

1. **Unpack**: `.mda` files are zip archives. They're unpacked with a built-in zip reader into a temporary folder, which is renamed only when complete. An interrupted run never leaves a half-unpacked package.
2. **Find operations used by the old app**: the native bundles (`native/bundle/android/assets/index.android.bundle`, `native/bundle/iOS/index.ios.bundle`) are Hermes bytecode. Operation IDs are stored in them as plain string literals, so every ID from the old `operations.json` that occurs in the bundle bytes is an operation the old app can call. The `.map` files aren't needed (they don't contain the original sources).
3. **Validate against the new package**: each ID is looked up in the new `operations.json`. Missing IDs are matched to their logical equivalent (same microflow, page + widget, entity, or parameters) to tell `CHANGED` from `REMOVED`.
4. **Offline schema**: `model/model.mdp` (the BSON runtime model) is read for both packages. The offline entities are the native navigation profile's offline entity configs (sync mode other than `Online`). Entities, attributes (including inherited and system attributes) and associations between offline entities are matched by their **GUID**, which stays the same across versions. A rename is therefore reported as a rename, and "deleted and recreated with the same name" is detected too.
5. **Native dependencies**: `model/nativeDependencies.json` of both packages is compared entry by entry, and `metadata.json` provides the Mendix runtime version.

## Limitations

- Only operation IDs present in the **old** `operations.json` are detected in the old bundle. IDs that are in the bundle but unknown to the old server are not reported.
- The tool shows *that* an operation is missing, not on which screen or nanoflow the old app calls it. Use the page/widget/microflow names in the report to find it.
- `CHANGED` matching for commit/delete/rollback is based on the parameters only. When several identical operations exist, the one with a new ID is shown as the replacement.
- Native dependency comparison can't see the installed app's Native Template version. It assumes the installed app matches the old package's `nativeDependencies.json`.
- Unpacked packages take about 300–350 MB each on disk. Delete the unpacked folders when you no longer need them. They're recreated from the `.mda` on the next run.

## Project structure

```
packages/                         .mda files and their unpacked folders
reports/                          generated reports (default --out)
tools/
  analyse-native-operations.js    main script (CLI, operations check, report)
  lib/
    bson.js                       reader for model/model.mdp
    offline-schema.js             offline schema compatibility check
    native-dependencies.js        native dependency check
```

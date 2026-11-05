#!/usr/bin/env node
/**
 * analyse-native-operations.js
 *
 * Finds which server operations used by an OLD Mendix native bundle are no longer
 * available in a NEW deployment package (i.e. what breaks for native clients that
 * are still running the old bundle after the server is upgraded).
 *
 * How it works
 *  1. Load OLD/model/operations.json  -> every operation the old server knew.
 *  2. Scan OLD native bundle(s) (Hermes bytecode or plain JS; android + iOS).
 *     Operation IDs are stored as string literals, so each old operationId that
 *     appears in the bundle bytes is an operation the old client can call.
 *  3. Load NEW/model/operations.json and check whether each of those IDs still exists.
 *  4. For missing IDs, look for the "same" logical operation in the new model
 *     (same microflow / page+widget / entity) and report what changed, so you can
 *     tell "ID regenerated because definition changed" from "removed entirely".
 *  5. Also reports operations that still exist but lost allowed user roles.
 *  6. Offline schema check (model/model.mdp): entities stored in the OLD app's device
 *     database must not be removed, renamed or change type, nor may their attributes
 *     or associations (Mendix offline-first guidance). See lib/offline-schema.js.
 *  7. Native dependencies (model/nativeDependencies.json): any difference means the
 *     Native Template must be updated and a new app built/released; an OTA update of
 *     the bundle alone is not enough. See lib/native-dependencies.js.
 *
 * Usage
 *   node tools/analyse-native-operations.js <old> <new> [--out <dir>] [--platform android|ios|all] [--force-extract]
 *
 *   <old>/<new> may be an extracted package folder OR a Mendix deployment archive (.mda).
 *   A .mda is unpacked next to itself (main-x.y.z.mda -> main-x.y.z/) unless that folder
 *   already contains model/operations.json. --force-extract re-unpacks it anyway.
 *   Passing a folder that doesn't exist but has a matching "<folder>.mda" also unpacks it.
 *
 * Output: <out>/breaking-operations.md, .json, .csv  (default out: ./reports)
 */
'use strict';
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { compareOfflineSchema } = require('./lib/offline-schema');
const { compareNativeDependencies } = require('./lib/native-dependencies');

// ---------- args ----------
const args = process.argv.slice(2);
const opt = (name, def) => {
  const i = args.indexOf(name);
  if (i === -1) return def;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const flag = (name) => {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
};
const forceExtract = flag('--force-extract');
const outDir = opt('--out', 'reports');
const platform = opt('--platform', 'all').toLowerCase();
if (args.length < 2) {
  console.error('Usage: node analyse-native-operations.js <old.mda|oldDir> <new.mda|newDir> [--out dir] [--platform android|ios|all] [--force-extract]');
  process.exit(1);
}

// ---------- .mda (zip) extraction ----------
/** Minimal zip reader (stored + deflate, zip64 aware). Returns entries with lazy data access. */
function readZipEntries(buf) {
  const EOCD = 0x06054b50;
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a zip/.mda file (end of central directory not found)');
  let count = buf.readUInt16LE(eocd + 10);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  if (count === 0xffff || cdOffset === 0xffffffff) {
    const loc = eocd - 20; // zip64 EOCD locator
    if (loc >= 0 && buf.readUInt32LE(loc) === 0x07064b50) {
      const z64 = Number(buf.readBigUInt64LE(loc + 8));
      count = Number(buf.readBigUInt64LE(z64 + 32));
      cdOffset = Number(buf.readBigUInt64LE(z64 + 48));
    }
  }
  const entries = [];
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error(`Corrupt central directory at ${p}`);
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    let compSize = buf.readUInt32LE(p + 20);
    let size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    let localOffset = buf.readUInt32LE(p + 42);
    const name = buf.toString(flags & 0x800 ? 'utf8' : 'latin1', p + 46, p + 46 + nameLen);
    // zip64 extended info
    let e = p + 46 + nameLen;
    const eEnd = e + extraLen;
    while (e + 4 <= eEnd) {
      const id = buf.readUInt16LE(e);
      const len = buf.readUInt16LE(e + 2);
      if (id === 0x0001) {
        let q = e + 4;
        if (size === 0xffffffff) { size = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (compSize === 0xffffffff) { compSize = Number(buf.readBigUInt64LE(q)); q += 8; }
        if (localOffset === 0xffffffff) { localOffset = Number(buf.readBigUInt64LE(q)); }
      }
      e += 4 + len;
    }
    entries.push({ name, method, compSize, size, localOffset, encrypted: !!(flags & 1) });
    p = eEnd + commentLen;
  }
  const data = (en) => {
    const lp = en.localOffset;
    if (buf.readUInt32LE(lp) !== 0x04034b50) throw new Error(`Corrupt local header for ${en.name}`);
    const start = lp + 30 + buf.readUInt16LE(lp + 26) + buf.readUInt16LE(lp + 28);
    const raw = buf.subarray(start, start + en.compSize);
    if (en.encrypted) throw new Error(`Encrypted entry not supported: ${en.name}`);
    if (en.method === 0) return raw;
    if (en.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Unsupported compression method ${en.method} for ${en.name}`);
  };
  return { entries, data };
}

function extractMda(mdaFile, targetDir) {
  const t0 = Date.now();
  console.error(`Unpacking ${path.basename(mdaFile)} -> ${targetDir} ...`);
  const { entries, data } = readZipEntries(fs.readFileSync(mdaFile));
  // Extract into a temp folder first, then rename, so an interrupted run never
  // leaves a half-extracted folder that would later be mistaken for a complete one.
  const tmp = `${targetDir}.extracting-${process.pid}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  const root = path.resolve(tmp);
  let files = 0;
  for (const en of entries) {
    const dest = path.resolve(root, en.name.replace(/\\/g, '/'));
    if (dest !== root && !dest.startsWith(root + path.sep)) throw new Error(`Unsafe path in archive: ${en.name}`); // zip-slip guard
    if (en.name.endsWith('/') || en.name.endsWith('\\')) { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, data(en));
    files++;
  }
  fs.rmSync(targetDir, { recursive: true, force: true });
  fs.renameSync(tmp, targetDir);
  console.error(`  ${files} files unpacked in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

const isExtracted = (dir) => fs.existsSync(path.join(dir, 'model', 'operations.json'));

/** Accept a package folder or a .mda; returns the extracted package folder. */
function resolvePackage(arg) {
  const p = path.resolve(arg);
  let mda = null;
  let dir = p;
  if (/\.mda$/i.test(p)) {
    mda = p;
    dir = p.replace(/\.mda$/i, '');
  } else if (!isExtracted(p) && fs.existsSync(`${p}.mda`)) {
    mda = `${p}.mda`;
  }
  if (mda) {
    if (!fs.existsSync(mda)) throw new Error(`.mda not found: ${mda}`);
    if (forceExtract || !isExtracted(dir)) extractMda(mda, dir);
    else console.error(`Using already unpacked ${dir} (use --force-extract to re-unpack)`);
  }
  if (!isExtracted(dir)) throw new Error(`Not a Mendix package folder (model/operations.json missing): ${dir}`);
  return dir;
}

const [oldDir, newDir] = args.map(resolvePackage);

// ---------- helpers ----------
const readOps = (dir) => {
  const f = path.join(dir, 'model', 'operations.json');
  if (!fs.existsSync(f)) throw new Error(`operations.json not found: ${f}`);
  return JSON.parse(fs.readFileSync(f, 'utf8'));
};

function findBundles(dir) {
  const base = path.join(dir, 'native', 'bundle');
  const candidates = [];
  if (platform === 'all' || platform === 'android')
    candidates.push(path.join(base, 'android', 'assets', 'index.android.bundle'));
  if (platform === 'all' || platform === 'ios')
    candidates.push(path.join(base, 'iOS', 'index.ios.bundle'), path.join(base, 'ios', 'index.ios.bundle'));
  // realpath dedupes iOS/ios on case-insensitive file systems (Windows/macOS)
  const real = candidates.filter((f) => fs.existsSync(f)).map((f) => fs.realpathSync.native(f));
  return [...new Set(real)];
}

function bundleKind(buf) {
  // Hermes bytecode magic: 0x1F1903C103BC1FC6 (little endian)
  return buf.length >= 8 && buf.readUInt32LE(0) === 0x03bc1fc6 && buf.readUInt32LE(4) === 0x1f1903c1
    ? 'hermes'
    : 'javascript';
}

/** Return Map<operationId, Set<bundleLabel>> of ops whose id occurs in the bundles. */
function scanBundles(bundles, ops, rootDir) {
  const used = new Map();
  const info = [];
  for (const file of bundles) {
    const buf = fs.readFileSync(file);
    // latin1 keeps a 1:1 byte mapping; IDs are pure ASCII. Also try UTF-16LE for
    // Hermes strings that were stored as UTF-16 (rare for IDs, but cheap to check).
    const s8 = buf.toString('latin1');
    const s16 = buf.toString('utf16le');
    const label = path.relative(rootDir, file).replace(/\\/g, '/');
    let n = 0;
    for (const op of ops) {
      if (s8.includes(op.operationId) || s16.includes(op.operationId)) {
        if (!used.has(op.operationId)) used.set(op.operationId, new Set());
        used.get(op.operationId).add(label);
        n++;
      }
    }
    info.push({ file: label, kind: bundleKind(buf), sizeBytes: buf.length, operationsReferenced: n });
  }
  return { used, info };
}

const shortName = (s) => (s || '').toString();
const objParams = (op) => JSON.stringify(op.parameters || {});

/** Logical identity of an operation, independent of its (hash-based) ID. */
function logicalKey(op) {
  const c = op.constants || {};
  switch (op.operationType) {
    case 'callMicroflow':
      return `callMicroflow|${c.MicroflowName}`;
    case 'retrieveByMicroflow':
      return `retrieveByMicroflow|${c.PageName}|${c.WidgetName}|${c.MicroflowName}`;
    case 'retrieve':
      return c.PageName || c.WidgetName
        ? `retrieve|${c.PageName}|${c.WidgetName}`
        : `retrieve|${c.ProfileName || ''}|${c.XPath || c.EntityPath || c.ObjectType || ''}`;
    case 'create':
      return `create|${c.ObjectType}`;
    default: // commit, delete, rollback, ...
      return `${op.operationType}|${objParams(op)}`;
  }
}

/** Looser key used when the strict key finds nothing (e.g. widget renamed, same page). */
function looseKey(op) {
  const c = op.constants || {};
  if (c.MicroflowName) return `mf|${op.operationType}|${c.MicroflowName}`;
  if (op.operationType === 'retrieve')
    return `ret|${c.PageName}|${c.XPath || c.EntityPath || c.ObjectType || ''}`;
  return null;
}

function describe(op) {
  const c = op.constants || {};
  const p = op.parameters || {};
  switch (op.operationType) {
    case 'callMicroflow':
      return `Microflow ${c.MicroflowName}`;
    case 'retrieveByMicroflow':
      return `Microflow ${c.MicroflowName} (datasource of ${c.WidgetName} on ${c.PageName})`;
    case 'retrieve': {
      const src = c.XPath ? `XPath ${c.XPath}` : c.EntityPath ? `association ${c.EntityPath}` : c.ObjectType || '';
      const where = c.PageName ? ` on ${c.PageName} / ${c.WidgetName}` : c.ProfileName ? ` (sync profile ${c.ProfileName})` : '';
      return `Retrieve ${src}${where}`;
    }
    case 'create':
      return `Create ${c.ObjectType}`;
    default:
      return `${op.operationType} ${Object.values(p).flat().join(', ')}`;
  }
}

function diff(a, b) {
  const out = [];
  const cmp = (label, x, y) => {
    const sx = JSON.stringify(x);
    const sy = JSON.stringify(y);
    if (sx !== sy) out.push({ field: label, old: x, new: y });
  };
  cmp('parameters', a.parameters, b.parameters);
  const keys = new Set([...Object.keys(a.constants || {}), ...Object.keys(b.constants || {})]);
  for (const k of keys) cmp(`constants.${k}`, (a.constants || {})[k], (b.constants || {})[k]);
  const ra = roleSetStrings(a);
  const rb = roleSetStrings(b);
  const removed = ra.filter((r) => !rb.includes(r));
  const added = rb.filter((r) => !ra.includes(r));
  if (removed.length || added.length) out.push({ field: 'allowedUserRoleSets', removed, added });
  return out;
}

const roleSetStrings = (op) => (op.allowedUserRoleSets || []).map((s) => [...s].sort().join('+')).sort();

// ---------- main ----------
const oldOps = readOps(oldDir);
const newOps = readOps(newDir);
const newById = new Map(newOps.map((o) => [o.operationId, o]));
const oldIdSet = new Set(oldOps.map((o) => o.operationId));
const index = (keyFn) => {
  const m = new Map();
  for (const o of newOps) {
    const k = keyFn(o);
    if (!k) continue;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(o);
  }
  return m;
};
const newByKey = index(logicalKey);
const newByLoose = index(looseKey);

const oldBundles = findBundles(oldDir);
if (!oldBundles.length) throw new Error(`No native bundles found under ${oldDir}/native/bundle`);
const { used, info: oldBundleInfo } = scanBundles(oldBundles, oldOps, oldDir);

// Sanity check: new bundle should reference only ops present in new model.
const newBundles = findBundles(newDir);
const { used: newUsed, info: newBundleInfo } = scanBundles(newBundles, newOps, newDir);

const usedOps = oldOps.filter((o) => used.has(o.operationId));
const missing = [];
const rolesReduced = [];

for (const op of usedOps) {
  const base = {
    operationId: op.operationId,
    operationType: op.operationType,
    description: describe(op),
    foundIn: [...used.get(op.operationId)],
    old: op,
  };
  const still = newById.get(op.operationId);
  if (still) {
    const removed = roleSetStrings(op).filter((r) => !roleSetStrings(still).includes(r));
    if (removed.length) rolesReduced.push({ ...base, removedRoleSets: removed });
    continue;
  }
  // Prefer candidates whose ID is new in the new package: an ID that already existed
  // in the old package is a different call site, not the replacement of this one.
  const preferNew = (list) => {
    const fresh = list.filter((c) => !oldIdSet.has(c.operationId));
    return fresh.length ? fresh : list;
  };
  let candidates = preferNew(newByKey.get(logicalKey(op)) || []);
  let matchQuality = candidates.length ? 'same logical operation' : null;
  if (!candidates.length) {
    const lk = looseKey(op);
    candidates = preferNew((lk && newByLoose.get(lk)) || []);
    if (candidates.length) matchQuality = 'similar operation (loose match)';
  }
  const status = candidates.length ? 'CHANGED' : 'REMOVED';
  missing.push({
    ...base,
    status,
    matchQuality,
    replacements: candidates.map((c) => ({
      operationId: c.operationId,
      usedByNewBundle: newUsed.has(c.operationId),
      changes: diff(op, c),
    })),
  });
}

missing.sort((a, b) => a.status.localeCompare(b.status) || a.operationType.localeCompare(b.operationType) || a.description.localeCompare(b.description));

const summary = {
  generatedAt: new Date().toISOString(),
  oldPackage: path.basename(oldDir),
  newPackage: path.basename(newDir),
  oldOperationsTotal: oldOps.length,
  newOperationsTotal: newOps.length,
  oldBundles: oldBundleInfo,
  newBundles: newBundleInfo,
  operationsUsedByOldBundle: usedOps.length,
  missingInNew: missing.length,
  missingRemoved: missing.filter((m) => m.status === 'REMOVED').length,
  missingChanged: missing.filter((m) => m.status === 'CHANGED').length,
  stillPresentButRolesReduced: rolesReduced.length,
  byType: missing.reduce((a, m) => ((a[m.operationType] = (a[m.operationType] || 0) + 1), a), {}),
};

// ---------- offline schema ----------
const offline = compareOfflineSchema(oldDir, newDir);
summary.offlineSchema = offline.summary;

// ---------- native dependencies ----------
const nativeDeps = compareNativeDependencies(oldDir, newDir);
summary.nativeDependencies = nativeDeps.summary;

// ---------- write outputs ----------
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(
  path.join(outDir, 'breaking-operations.json'),
  JSON.stringify({ summary, missing, rolesReduced, offlineSchema: offline.findings, nativeDependencies: nativeDeps.findings }, null, 2)
);
{
  const rows = [
    ['change', 'dependency', 'oldVersion', 'newVersion', 'bump', 'impact'],
    ...nativeDeps.findings.map((f) => [f.change, f.dependency, f.oldVersion, f.newVersion, f.bump, f.impact]),
  ];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(outDir, 'native-dependencies.csv'), '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n'));
}
{
  const rows = [
    ['severity', 'category', 'element', 'message', 'inheritedFrom', 'newName'],
    ...offline.findings.map((f) => [f.severity, f.category, f.element, f.message, f.inheritedFrom, f.newName]),
  ];
  const esc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  fs.writeFileSync(path.join(outDir, 'offline-schema.csv'), '﻿' + rows.map((r) => r.map(esc).join(',')).join('\r\n'));
}

const csvEsc = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
const csvRows = [
  ['status', 'operationId', 'operationType', 'description', 'MicroflowName', 'PageName', 'WidgetName', 'XPath/EntityPath/ObjectType', 'parameters', 'allowedUserRoleSets', 'foundInBundles', 'replacementIds', 'changes'],
  ...missing.map((m) => {
    const c = m.old.constants || {};
    return [
      m.status, m.operationId, m.operationType, m.description, c.MicroflowName, c.PageName, c.WidgetName,
      c.XPath || c.EntityPath || c.ObjectType, objParams(m.old), roleSetStrings(m.old).join(' | '), m.foundIn.join(' | '),
      m.replacements.map((r) => r.operationId).join(' | '),
      m.replacements.map((r) => r.changes.map((d) => d.field).join(', ')).join(' | '),
    ];
  }),
];
fs.writeFileSync(path.join(outDir, 'breaking-operations.csv'), '﻿' + csvRows.map((r) => r.map(csvEsc).join(',')).join('\r\n'));

const j = (v) => '`' + JSON.stringify(v) + '`';
const md = [];
md.push(`# Native client breaking-change analysis`, '');
{
  const nd = nativeDeps.summary;
  md.push(
    nd.newAppRequired
      ? `> **Verdict: NEW APP REQUIRED.** Native dependencies${nd.runtimeChange && /major/.test(nd.runtimeChange) ? ' and/or Mendix major version' : ''} differ: update the Native Template, build and release a new app. An OTA update alone is not sufficient.`
      : nd.missingFile
        ? `> **Verdict: UNKNOWN.** nativeDependencies.json missing in ${!nd.oldFile ? 'old' : 'new'} package; native dependencies not compared.`
        : `> **Verdict: native dependencies match.** The new bundle can run on the existing app binary (OTA possible, subject to the server/offline findings below).`,
    ''
  );
}
md.push(`- Old package: **${summary.oldPackage}** (${summary.oldOperationsTotal} operations)`);
md.push(`- New package: **${summary.newPackage}** (${summary.newOperationsTotal} operations)`);
for (const b of oldBundleInfo) md.push(`- Old bundle \`${b.file}\` (${b.kind}): references ${b.operationsReferenced} operations`);
md.push(`- Operations used by old native bundle: **${summary.operationsUsedByOldBundle}**`);
md.push(`- **No longer available in new package: ${summary.missingInNew}** (${summary.missingChanged} changed / ID regenerated, ${summary.missingRemoved} removed entirely)`);
md.push(`- Still available but with fewer allowed role sets: ${summary.stillPresentButRolesReduced}`);
md.push(`- Offline schema: **${offline.summary.breaking} breaking**, ${offline.summary.warnings} warnings (runtime ${offline.summary.oldRuntimeVersion} → ${offline.summary.newRuntimeVersion})`);
md.push(`- Native dependencies: ${nativeDeps.summary.missingFile ? 'not compared (file missing)' : `**${nativeDeps.findings.length} differences** (${nativeDeps.summary.added} added, ${nativeDeps.summary.removed} removed, ${nativeDeps.summary.versionChanged} version changed)`}`, '');
md.push(`Missing by type: ${Object.entries(summary.byType).map(([k, v]) => `${k}: ${v}`).join(', ') || 'none'}`, '');
md.push(`An old client calling any operation below gets an error from the new server ("operation not found" or access denied).`, '');

md.push(`## Overview`, '');
md.push(`| # | Status | Operation ID | Type | Description |`);
md.push(`|---|---|---|---|---|`);
missing.forEach((m, i) => md.push(`| ${i + 1} | ${m.status} | \`${m.operationId}\` | ${m.operationType} | ${m.description.replace(/\|/g, '\\|')} |`));
md.push('');

md.push(`## Details`, '');
missing.forEach((m, i) => {
  md.push(`### ${i + 1}. ${m.status}: ${m.description}`, '');
  md.push(`- Operation ID: \`${m.operationId}\``);
  md.push(`- Type: ${m.operationType}`);
  for (const [k, v] of Object.entries(m.old.constants || {})) if (!(Array.isArray(v) && !v.length)) md.push(`- ${k}: ${j(v)}`);
  if (Object.keys(m.old.parameters || {}).length) md.push(`- Parameters: ${j(m.old.parameters)}`);
  md.push(`- Allowed role sets: ${roleSetStrings(m.old).join(', ')}`);
  md.push(`- Referenced in: ${m.foundIn.join(', ')}`);
  if (m.replacements.length) {
    md.push(`- Closest match in new package (${m.matchQuality}):`);
    for (const r of m.replacements) {
      md.push(`  - \`${r.operationId}\`${r.usedByNewBundle ? ' (used by new bundle)' : ''}`);
      for (const d of r.changes) {
        if (d.field === 'allowedUserRoleSets')
          md.push(`    - roles: removed [${d.removed.join(', ')}] added [${d.added.join(', ')}]`);
        else md.push(`    - ${d.field}: ${j(d.old)} → ${j(d.new)}`);
      }
      if (!r.changes.length)
        md.push(`    - definition identical; only the ID was regenerated (e.g. the widget/action calling it was recreated in the model)`);
    }
  } else {
    md.push(`- No equivalent operation in new package: removed.`);
  }
  md.push('');
});

if (rolesReduced.length) {
  md.push(`## Still present, but allowed role sets reduced`, '');
  md.push(`| Operation ID | Type | Description | Removed role sets |`);
  md.push(`|---|---|---|---|`);
  for (const r of rolesReduced) md.push(`| \`${r.operationId}\` | ${r.operationType} | ${r.description.replace(/\|/g, '\\|')} | ${r.removedRoleSets.join(', ')} |`);
  md.push('');
}

{
  const s = offline.summary;
  md.push(`## Offline schema compatibility`, '');
  md.push(`> Mendix guidance: do not remove, rename, or change the type of entities or their attributes in offline apps after the initial release. If needed, ship a backwards-compatible in-between release first and make the change in the next release, after all apps are synchronized.`, '');
  md.push(`- Native profiles checked: ${s.profilesChecked.join(', ') || 'none (no offline native profile)'}`);
  md.push(`- Offline entities (old → new): ${Object.entries(s.offlineEntitiesOld).map(([p, n]) => `${p}: ${n} → ${s.offlineEntitiesNew[p] ?? 0}`).join(', ')}`);
  md.push(`- Entities, attributes (incl. inherited/system) and associations between offline entities are matched by GUID, so renames are detected.`);
  md.push(`- Result: **${s.breaking} breaking**, ${s.warnings} warnings`, '');
  if (offline.findings.length) {
    md.push(`| # | Severity | Category | Element | Finding |`);
    md.push(`|---|---|---|---|---|`);
    offline.findings.forEach((f, i) =>
      md.push(`| ${i + 1} | ${f.severity} | ${f.category} | \`${f.element}\` | ${f.message.replace(/\|/g, '\\|')}${f.inheritedFrom ? ` (inherited from ${f.inheritedFrom})` : ''} |`)
    );
    md.push('');
  }
}

{
  const s = nativeDeps.summary;
  md.push(`## Native dependencies`, '');
  md.push(`Source: \`model/nativeDependencies.json\`. These native modules must be compiled into the app binary (Native Template). If they differ, the Native Template has to be updated and a new app built and released; the old installed app cannot run the new bundle.`, '');
  if (s.missingFile) md.push(`- nativeDependencies.json missing in ${!s.oldFile ? 'old' : 'new'} package; not compared.`);
  else {
    md.push(`- Dependencies old → new: ${s.oldCount} → ${s.newCount} (${s.unchanged} unchanged, ${s.added} added, ${s.removed} removed, ${s.versionChanged} version changed)`);
  }
  if (s.runtimeChange) md.push(`- ${s.runtimeChange}`);
  md.push(`- **New app build required: ${s.newAppRequired ? 'YES' : 'no'}**`, '');
  if (nativeDeps.findings.length) {
    md.push(`| Change | Dependency | Old | New | Bump | Impact |`);
    md.push(`|---|---|---|---|---|---|`);
    for (const f of nativeDeps.findings)
      md.push(`| ${f.change} | \`${f.dependency}\` | ${f.oldVersion} | ${f.newVersion} | ${f.bump || ''} | ${f.impact} |`);
    md.push('');
  }
}

md.push(`## Sanity check (new bundle)`, '');
for (const b of newBundleInfo) md.push(`- New bundle \`${b.file}\` (${b.kind}): references ${b.operationsReferenced} operations from new operations.json`);
fs.writeFileSync(path.join(outDir, 'breaking-operations.md'), md.join('\n'));

// ---------- console ----------
console.log(JSON.stringify(summary, null, 2));
console.log(`\nReports written to ${path.resolve(outDir)}`);
// non-zero for CI gating: 2 = breaking for old clients / new app required
process.exitCode = missing.length || offline.summary.breaking || nativeDeps.summary.newAppRequired ? 2 : 0;

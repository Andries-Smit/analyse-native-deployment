'use strict';
/**
 * Native dependency compatibility check.
 *
 * model/nativeDependencies.json lists the native (React Native) modules the JS bundle
 * needs to be present in the installed app binary (built from the Native Template).
 * If the list differs between the old and new package, the new bundle cannot run on the
 * old binary: the Native Template must be updated and a new app built and released
 * (an OTA / bundle-only update is not sufficient).
 *
 * The Native Template version is also tied to the Mendix (Studio Pro) version, so a
 * runtime major/minor version change is reported as well.
 */
const fs = require('fs');
const path = require('path');

function readDeps(pkgDir) {
  const f = path.join(pkgDir, 'model', 'nativeDependencies.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8'));
}

function readRuntime(pkgDir) {
  const f = path.join(pkgDir, 'model', 'metadata.json');
  if (!fs.existsSync(f)) return null;
  return JSON.parse(fs.readFileSync(f, 'utf8')).RuntimeVersion || null;
}

const parse = (v) => {
  const m = String(v).match(/(\d+)(?:\.(\d+))?(?:\.(\d+))?/);
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null;
};

function bump(oldV, newV) {
  const a = parse(oldV);
  const b = parse(newV);
  if (!a || !b) return 'changed';
  const dir = a[0] !== b[0] ? b[0] - a[0] : a[1] !== b[1] ? b[1] - a[1] : b[2] - a[2];
  const level = a[0] !== b[0] ? 'major' : a[1] !== b[1] ? 'minor' : 'patch';
  return `${level} ${dir < 0 ? 'downgrade' : 'upgrade'}`;
}

function compareNativeDependencies(oldDir, newDir) {
  const oldDeps = readDeps(oldDir);
  const newDeps = readDeps(newDir);
  const findings = [];

  if (oldDeps && newDeps) {
    const names = [...new Set([...Object.keys(oldDeps), ...Object.keys(newDeps)])].sort();
    for (const name of names) {
      const o = oldDeps[name];
      const n = newDeps[name];
      if (o === n) continue;
      if (o === undefined)
        findings.push({ change: 'ADDED', dependency: name, oldVersion: '', newVersion: n,
          impact: 'New native module: not present in the installed app; the new bundle will fail (crash/red screen) where it is used.' });
      else if (n === undefined)
        findings.push({ change: 'REMOVED', dependency: name, oldVersion: o, newVersion: '',
          impact: 'No longer needed by the new bundle; Native Template should be updated to drop it.' });
      else
        findings.push({ change: 'VERSION', dependency: name, oldVersion: o, newVersion: n, bump: bump(o, n),
          impact: 'Installed app contains a different native version than the new bundle was built for.' });
    }
  }

  const oldRuntime = readRuntime(oldDir);
  const newRuntime = readRuntime(newDir);
  const ro = parse(oldRuntime || '');
  const rn = parse(newRuntime || '');
  const runtimeChange =
    ro && rn && (ro[0] !== rn[0] || ro[1] !== rn[1])
      ? `Mendix runtime ${oldRuntime} → ${newRuntime} (${ro[0] !== rn[0] ? 'major' : 'minor'} version change): verify the Native Template version is compatible with Mendix ${rn[0]}.${rn[1]}.`
      : null;

  const missingFile = !oldDeps || !newDeps;
  const newAppRequired = findings.length > 0 || (ro && rn && ro[0] !== rn[0]);
  return {
    summary: {
      oldFile: !!oldDeps,
      newFile: !!newDeps,
      oldCount: oldDeps ? Object.keys(oldDeps).length : null,
      newCount: newDeps ? Object.keys(newDeps).length : null,
      added: findings.filter((f) => f.change === 'ADDED').length,
      removed: findings.filter((f) => f.change === 'REMOVED').length,
      versionChanged: findings.filter((f) => f.change === 'VERSION').length,
      unchanged: oldDeps && newDeps ? Object.keys(oldDeps).filter((k) => oldDeps[k] === newDeps[k]).length : null,
      oldRuntime,
      newRuntime,
      runtimeChange,
      missingFile,
      newAppRequired: !!newAppRequired,
    },
    findings,
  };
}

module.exports = { compareNativeDependencies };

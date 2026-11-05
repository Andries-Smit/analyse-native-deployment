'use strict';
/**
 * Offline schema compatibility check for Mendix native apps.
 *
 * Mendix guidance: "Do not remove, rename, or change the type of entities or their
 * attributes in offline apps after your initial release — this may cause objects or
 * values to be no longer accessible to offline users."
 *
 * Reads model/model.mdp (BSON runtime model) of both packages, determines the entities
 * stored in the device database of the OLD app (native navigation profile offline
 * entity configs, SyncMode != "Online"), and checks that their entities, attributes
 * and associations still exist unchanged in the NEW model. Elements are matched by
 * their GUID (stable across versions), so renames are detected as renames.
 */
const fs = require('fs');
const path = require('path');
const { readAll } = require('./bson');

const T = (o) => o && o.$Type;
const short = (t) => (t || '').replace(/^DomainModels\$/, '').replace(/AttributeType$/, '');

function walk(x, f) {
  if (x && typeof x === 'object') {
    f(x);
    for (const v of Object.values(x)) walk(v, f);
  }
}

// System members added by generalization flags (System.* attributes/associations).
const SYSTEM_MEMBERS = [
  ['HasCreatedDateAttr', 'attribute', 'createdDate'],
  ['HasChangedDateAttr', 'attribute', 'changedDate'],
  ['HasOwnerAttr', 'association', 'System.owner'],
  ['HasChangedByAttr', 'association', 'System.changedBy'],
];

function loadModel(pkgDir) {
  const docs = readAll(fs.readFileSync(path.join(pkgDir, 'model', 'model.mdp')));
  const entities = new Map(); // qname -> entity
  const entityById = new Map(); // $ID -> qname
  const associations = []; // raw
  const enums = new Map(); // qname -> [value names]
  const profiles = new Map(); // profile name -> [{entity, syncMode, constraint}]

  // Enumerations: qualified name = module name + "." + document name
  let moduleName = null;
  for (const d of docs) {
    if (T(d) === 'Projects$ModuleImpl') moduleName = d.Name;
    if (T(d) === 'Enumerations$Enumeration') {
      const qn = d.QualifiedName || (d.Name && moduleName ? `${moduleName}.${d.Name}` : null);
      if (qn) enums.set(qn, (d.Values || []).map((v) => v.Name));
    }
  }

  walk(docs, (o) => {
    switch (T(o)) {
      case 'DomainModels$EntityImpl': {
        const g = o.MaybeGeneralization || {};
        const ent = {
          qname: o.QualifiedName,
          guid: o.GUID,
          persistable: g.Persistable !== false,
          generalization: T(g) === 'DomainModels$Generalization' ? g.Generalization : null,
          systemFlags: Object.fromEntries(SYSTEM_MEMBERS.map(([f]) => [f, !!g[f]])),
          attributes: (o.Attributes || []).map((a) => ({
            name: a.Name,
            guid: a.GUID,
            type: short(T(a.Type)),
            length: a.Type && a.Type.Length,
            enumeration: a.Type && a.Type.Enumeration,
            calculated: T(a.Value) === 'DomainModels$CalculatedValue',
            owner: o.QualifiedName,
          })),
        };
        entities.set(ent.qname, ent);
        entityById.set(o.$ID, ent.qname);
        break;
      }
      case 'DomainModels$Association':
      case 'DomainModels$CrossAssociation':
        associations.push(o);
        break;
      case 'Navigation$NativeNavigationProfile': {
        const cfg = o.OfflineEntityConfigsRuntime || o.OfflineEntityConfigs || [];
        profiles.set(o.Name, cfg.map((c) => ({ entity: c.Entity, syncMode: c.SyncMode, constraint: c.Constraint })));
        break;
      }
    }
  });

  const assocs = new Map(
    associations.map((a) => [
      a.QualifiedName,
      {
        qname: a.QualifiedName,
        guid: a.GUID,
        type: a.Type,
        owner: a.Owner,
        storage: a.StorageFormat,
        parent: entityById.get(a.ParentPointer) || a.ParentPointer,
        child: a.Child || entityById.get(a.ChildPointer) || a.ChildPointer,
      },
    ])
  );

  const metaFile = path.join(pkgDir, 'model', 'metadata.json');
  const meta = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf8')) : {};
  return { entities, assocs, enums, profiles, runtimeVersion: meta.RuntimeVersion, modelVersion: meta.ModelVersion };
}

/** Own + inherited attributes, plus system attributes enabled through generalization flags. */
function effectiveAttributes(model, qname, seen = new Set()) {
  const e = model.entities.get(qname);
  if (!e || seen.has(qname)) return [];
  seen.add(qname);
  const own = e.attributes.slice();
  for (const [flag, kind, name] of SYSTEM_MEMBERS)
    if (kind === 'attribute' && e.systemFlags[flag])
      own.push({ name, guid: `system:${name}`, type: 'DateTime', owner: qname, system: true });
  const inherited = e.generalization ? effectiveAttributes(model, e.generalization, seen) : [];
  return [...inherited, ...own];
}

const isOffline = (c) => c.syncMode !== 'Online';

function compareOfflineSchema(oldDir, newDir) {
  return compareModels(loadModel(oldDir), loadModel(newDir));
}

function compareModels(oldM, newM) {
  const findings = [];
  const add = (severity, category, element, message, extra = {}) =>
    findings.push({ severity, category, element, message, ...extra });

  const newEntByGuid = new Map([...newM.entities.values()].map((e) => [e.guid, e]));
  const newAssocByGuid = new Map([...newM.assocs.values()].map((a) => [a.guid, a]));
  const profilesChecked = [];

  for (const [profile, oldCfgAll] of oldM.profiles) {
    const oldCfg = oldCfgAll.filter(isOffline);
    if (!oldCfg.length) continue;
    profilesChecked.push(profile);
    const newCfg = new Map((newM.profiles.get(profile) || []).map((c) => [c.entity, c]));
    if (!newM.profiles.has(profile))
      add('BREAKING', 'profile', profile, `Native navigation profile "${profile}" no longer exists in the new model.`);

    const oldOffline = new Set(oldCfg.map((c) => c.entity));
    const renameMap = new Map(); // old entity qname -> new entity qname

    // ---- entities ----
    for (const c of oldCfg) {
      const oe = oldM.entities.get(c.entity);
      if (!oe) continue;
      let ne = newM.entities.get(c.entity);
      if (ne && ne.guid !== oe.guid) {
        add('BREAKING', 'entity', c.entity, `Entity was deleted and recreated with the same name (new GUID); local data is not carried over.`);
      }
      if (!ne) {
        ne = newEntByGuid.get(oe.guid);
        if (ne) add('BREAKING', 'entity', c.entity, `Entity renamed to ${ne.qname}.`, { newName: ne.qname });
        else {
          add('BREAKING', 'entity', c.entity, `Entity removed from the domain model.`);
          continue;
        }
      }
      renameMap.set(oe.qname, ne.qname);

      const nc = newCfg.get(ne.qname);
      if (!nc) add('BREAKING', 'entity', c.entity, `Entity is no longer part of the offline database of profile ${profile}.`);
      else if (!isOffline(nc))
        add('BREAKING', 'entity', c.entity, `Sync mode changed from "${c.syncMode}" to "Online": entity is no longer stored on the device; local (unsynced) objects become inaccessible.`);
      else if (nc.syncMode !== c.syncMode)
        add('WARNING', 'sync', c.entity, `Sync mode changed: ${c.syncMode} → ${nc.syncMode}.`);
      else if ((nc.constraint || '') !== (c.constraint || ''))
        add('WARNING', 'sync', c.entity, `Sync constraint changed: "${c.constraint}" → "${nc.constraint}".`);

      if (oe.persistable !== ne.persistable)
        add('BREAKING', 'entity', c.entity, `Persistable changed: ${oe.persistable} → ${ne.persistable}.`);
      if ((oe.generalization || null) !== (ne.generalization || null))
        add('BREAKING', 'entity', c.entity, `Generalization changed: ${oe.generalization || '(none)'} → ${ne.generalization || '(none)'}.`);

      // ---- attributes ----
      const oAttrs = effectiveAttributes(oldM, oe.qname);
      const nAttrs = effectiveAttributes(newM, ne.qname);
      const nByGuid = new Map(nAttrs.map((a) => [a.guid, a]));
      const nByName = new Map(nAttrs.map((a) => [a.name, a]));
      for (const oa of oAttrs) {
        const where = `${c.entity}.${oa.name}`;
        const inh = oa.owner !== oe.qname ? { inheritedFrom: oa.owner } : {};
        let na = nByGuid.get(oa.guid);
        if (!na) {
          const sameName = nByName.get(oa.name);
          if (sameName) {
            add('BREAKING', 'attribute', where, `Attribute was deleted and recreated (new GUID); stored offline values are lost.`, inh);
            na = sameName;
          } else {
            add('BREAKING', 'attribute', where, `Attribute removed.`, inh);
            continue;
          }
        } else if (na.name !== oa.name) {
          add('BREAKING', 'attribute', where, `Attribute renamed to ${na.name}.`, { ...inh, newName: na.name });
        }
        if (na.type !== oa.type)
          add('BREAKING', 'attribute', where, `Type changed: ${oa.type} → ${na.type}.`, inh);
        else {
          if (oa.type === 'String' && oa.length && (na.length === 0 ? false : na.length < oa.length))
            add('WARNING', 'attribute', where, `String length reduced: ${oa.length} → ${na.length || 'unlimited'}; longer offline values may fail to sync.`, inh);
          if (oa.type === 'Enumeration' && oa.enumeration !== na.enumeration)
            add('BREAKING', 'attribute', where, `Enumeration changed: ${oa.enumeration} → ${na.enumeration}.`, inh);
          if (oa.type === 'Enumeration' && oa.enumeration === na.enumeration) {
            const ov = oldM.enums.get(oa.enumeration) || [];
            const nv = new Set(newM.enums.get(na.enumeration) || []);
            const removed = ov.filter((v) => !nv.has(v));
            if (removed.length)
              add('WARNING', 'enumeration', where, `Enumeration ${oa.enumeration} values removed: ${removed.join(', ')}; offline objects holding these values become invalid.`, inh);
          }
        }
        if (!oa.calculated && na.calculated)
          add('BREAKING', 'attribute', where, `Stored attribute became calculated (not available offline).`, inh);
      }
      for (const [flag, kind, name] of SYSTEM_MEMBERS)
        if (kind === 'association' && oe.systemFlags[flag] && !ne.systemFlags[flag])
          add('BREAKING', 'association', `${c.entity}/${name}`, `System association ${name} removed (${flag} turned off).`);
    }

    // ---- associations between offline entities ----
    for (const oa of oldM.assocs.values()) {
      if (!oldOffline.has(oa.parent) || !oldOffline.has(oa.child)) continue;
      let na = newM.assocs.get(oa.qname);
      if (na && na.guid !== oa.guid)
        add('BREAKING', 'association', oa.qname, `Association was deleted and recreated (new GUID); offline references are lost.`);
      if (!na) {
        na = newAssocByGuid.get(oa.guid);
        if (na) add('BREAKING', 'association', oa.qname, `Association renamed to ${na.qname}.`, { newName: na.qname });
        else {
          add('BREAKING', 'association', oa.qname, `Association removed (${oa.parent} → ${oa.child}).`);
          continue;
        }
      }
      if (na.type !== oa.type) add('BREAKING', 'association', oa.qname, `Type changed: ${oa.type} → ${na.type}.`);
      if (na.owner !== oa.owner) add('BREAKING', 'association', oa.qname, `Owner changed: ${oa.owner} → ${na.owner}.`);
      const expP = renameMap.get(oa.parent) || oa.parent;
      const expC = renameMap.get(oa.child) || oa.child;
      if (na.parent !== expP || na.child !== expC)
        add('BREAKING', 'association', oa.qname, `Association ends changed: ${oa.parent} → ${oa.child}  became  ${na.parent} → ${na.child}.`);
    }
  }

  const order = { BREAKING: 0, WARNING: 1 };
  findings.sort((a, b) => order[a.severity] - order[b.severity] || a.element.localeCompare(b.element));

  const offlineCount = (m) => {
    const out = {};
    for (const [p, cfg] of m.profiles) out[p] = cfg.filter(isOffline).length;
    return out;
  };
  return {
    summary: {
      oldRuntimeVersion: oldM.runtimeVersion,
      newRuntimeVersion: newM.runtimeVersion,
      profilesChecked,
      offlineEntitiesOld: offlineCount(oldM),
      offlineEntitiesNew: offlineCount(newM),
      breaking: findings.filter((f) => f.severity === 'BREAKING').length,
      warnings: findings.filter((f) => f.severity === 'WARNING').length,
    },
    findings,
  };
}

module.exports = { compareOfflineSchema, compareModels, loadModel };

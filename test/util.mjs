/* Shared test plumbing. */

/*
   Flattens module namespaces into one object of live getters. Getters rather
   than a spread because bindings like `state` are reassigned: a snapshot copy
   would go stale the moment a document is replaced.
*/
export function flatten(namespaces) {
  const t = {};
  for (const ns of Object.values(namespaces)) {
    for (const key of Object.keys(ns)) {
      Object.defineProperty(t, key, {
        get: () => ns[key],
        configurable: true,
        enumerable: true,
      });
    }
    if ('selectedTemplateId' in ns) {
      Object.defineProperty(t, 'sel', { get: () => ns.selectedTemplateId, configurable: true });
    }
  }
  return t;
}

export function checker(label) {
  let pass = 0, fail = 0;
  return {
    ok(name, cond, extra) {
      if (cond) pass++;
      else {
        fail++;
        console.log(`FAIL [${label}] ${name}${extra ? '  ' + extra : ''}`);
      }
    },
    totals: () => ({ pass, fail, label }),
  };
}

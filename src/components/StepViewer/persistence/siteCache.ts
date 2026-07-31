const KNOWN_DATABASES = ["step2urdf"];

export interface SiteCacheUsage {
  caches: number;
  serviceWorkers: number;
  localStorageKeys: number;
  sessionStorageKeys: number;
  databases: number;
  totalBytes: number;
}

export interface SiteCacheReport {
  caches: number;
  serviceWorkers: number;
  localStorageKeys: number;
  sessionStorageKeys: number;
  databases: number;
  failures: string[];
}

async function cacheNames(): Promise<string[]> {
  try {
    if (typeof caches === "undefined") return [];
    return await caches.keys();
  } catch {
    return [];
  }
}

async function serviceWorkerRegistrations(): Promise<readonly ServiceWorkerRegistration[]> {
  try {
    if (!navigator.serviceWorker?.getRegistrations) return [];
    return await navigator.serviceWorker.getRegistrations();
  } catch {
    return [];
  }
}

async function databaseNames(): Promise<string[]> {
  const found = new Set<string>(KNOWN_DATABASES);
  try {
    const enumerate = (
      indexedDB as IDBFactory & { databases?: () => Promise<{ name?: string }[]> }
    ).databases;
    if (typeof enumerate === "function") {
      const list = await enumerate.call(indexedDB);
      for (const entry of list) {
        if (entry?.name) found.add(entry.name);
      }
    }
  } catch {}
  return Array.from(found);
}

function storageKeyCount(storage: Storage | undefined): number {
  try {
    return storage?.length ?? 0;
  } catch {
    return 0;
  }
}

export async function measureSiteCache(): Promise<SiteCacheUsage> {
  const [names, registrations, databases] = await Promise.all([
    cacheNames(),
    serviceWorkerRegistrations(),
    databaseNames(),
  ]);

  let totalBytes = 0;
  try {
    if (typeof navigator.storage?.estimate === "function") {
      const { usage = 0 } = await navigator.storage.estimate();
      totalBytes = usage;
    }
  } catch {}

  return {
    caches: names.length,
    serviceWorkers: registrations.length,
    localStorageKeys: storageKeyCount(globalThis.localStorage),
    sessionStorageKeys: storageKeyCount(globalThis.sessionStorage),
    databases: databases.length,
    totalBytes,
  };
}

function deleteDatabase(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => finish(true);
      request.onerror = () => finish(false);
      request.onblocked = () => finish(false);
      setTimeout(() => finish(false), 3000);
    } catch {
      finish(false);
    }
  });
}

export async function clearSiteCache(): Promise<SiteCacheReport> {
  const failures: string[] = [];
  const report: SiteCacheReport = {
    caches: 0,
    serviceWorkers: 0,
    localStorageKeys: 0,
    sessionStorageKeys: 0,
    databases: 0,
    failures,
  };

  for (const name of await cacheNames()) {
    try {
      if (await caches.delete(name)) report.caches++;
    } catch {
      failures.push(`缓存 ${name}`);
    }
  }

  for (const registration of await serviceWorkerRegistrations()) {
    try {
      if (await registration.unregister()) report.serviceWorkers++;
    } catch {
      failures.push("Service Worker");
    }
  }

  try {
    report.localStorageKeys = storageKeyCount(globalThis.localStorage);
    globalThis.localStorage?.clear();
  } catch {
    failures.push("localStorage");
  }

  try {
    report.sessionStorageKeys = storageKeyCount(globalThis.sessionStorage);
    globalThis.sessionStorage?.clear();
  } catch {
    failures.push("sessionStorage");
  }

  for (const name of await databaseNames()) {
    if (await deleteDatabase(name)) report.databases++;
    else failures.push(`数据库 ${name}`);
  }

  return report;
}

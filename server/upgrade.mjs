import * as sqlite from 'node:sqlite';
import { mkdir, stat, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

// Make a consistent SQLite snapshot (including committed WAL changes) before
// any account-schema migration. The ordinary Chrome profiles are untouched.
export async function backupBeforeAccounts(dataDir) {
  const path=join(dataDir,'catchtable.sqlite');
  try {await stat(path);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const database=new sqlite.DatabaseSync(path,{readOnly:true});
  try {
    const exists=database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='accounts'").get();
    if(exists && database.prepare("SELECT id FROM accounts WHERE id='default'").get())return null;
    const directory=join(dataDir,'backups',`pre-multi-account-${new Date().toISOString().replace(/[:.]/g,'-')}`);
    await mkdir(directory,{recursive:true});
    const destination=join(directory,'catchtable.sqlite');
    if(typeof sqlite.backup!=='function')throw new Error('升级备份需要 Node.js 22.16 或更高版本，请升级 Node.js 后重试。');
    await sqlite.backup(database,destination);
    try {await copyFile(join(dataDir,'extension-pairing.key'),join(directory,'extension-pairing.key'));}
    catch(error){if(error.code!=='ENOENT')throw error;}
    await writeFile(join(directory,'backup.json'),JSON.stringify({version:'single-account-v1',commit:'ea101936caa6b4b733b6d159035abff76f9e015f',createdAt:new Date().toISOString(),database:'catchtable.sqlite'},null,2));
    return directory;
  }finally {database.close();}
}

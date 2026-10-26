import fs from 'node:fs';
import path from 'node:path';

const cgroup = new URL(import.meta.url).searchParams.get('cgroup');
if (!cgroup) throw new Error('CPU scope preload requires a cgroup directory');
fs.writeFileSync(path.join(cgroup, 'cgroup.procs'), String(process.pid), { flag: 'r+' });

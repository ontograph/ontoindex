import { getUsers, getUserSet, getIndex } from './models';

function process() {
  const users = getUsers();
  for (const u of users) {
    u.save();
  }
}

function processIndex() {
  const index = getIndex();
  for (const entry of index) {
    entry.save();
  }
}

function processSet() {
  const members = getUserSet();
  for (const m of members) {
    m.save();
  }
}

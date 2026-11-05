// GameBuddy backend: Node.js 18+, MongoDB for storage.
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { MongoClient } = require('mongodb');

const PORT = process.env.PORT || 3000;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || 'gamebuddy';
const PUBLIC_DIR = path.join(__dirname, 'public');

const META = {
  games: ['APEX Legends', 'Valorant', 'League of Legends', 'Overwatch 2', 'Fortnite', 'Minecraft', 'Genshin Impact', 'Among Us'],
  platforms: ['PC', 'PlayStation', 'Xbox', 'Nintendo Switch', 'Mobile'],
  levels: ['เริ่มต้น', 'ปานกลาง', 'เก่ง', 'สายโปร'],
  avatars: ['🐰', '🐱', '🐼', '🦊', '🐸', '🐧', '🦉', '🐯'],
};

const db = {
  seq: 1, users: {}, sessions: {}, friendships: [], dms: [], reads: {},
  groups: {}, notifications: [], queue: [], matchResults: [], matches: [],
  ratings: [], visits: [], orders: [], rooms: [],
};
const KEYS = Object.keys(db);
let stateCol = null;
let imageCol = null;

let saveTimer = null;
let saving = Promise.resolve();
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saving = saving.then(flush).catch((e) => console.error('บันทึกข้อมูลไม่สำเร็จ:', e.message));
  }, 300);
}
async function flush() {
  if (!stateCol) return;
  await stateCol.bulkWrite(KEYS.map((k) => ({
    replaceOne: { filter: { _id: k }, replacement: { _id: k, value: db[k] }, upsert: true },
  })));
}
async function loadDb() {
  const docs = await stateCol.find({}).toArray();
  for (const d of docs) if (KEYS.includes(d._id)) db[d._id] = d.value;
  if (!Array.isArray(db.rooms)) db.rooms = [];
}
const nextId = (prefix = '') => prefix + (db.seq++).toString(36) + crypto.randomBytes(3).toString('hex');

function hashPw(pw, salt = crypto.randomBytes(16).toString('hex')) {
  return { salt, hash: crypto.scryptSync(pw, salt, 64).toString('hex') };
}
function checkPw(user, pw) {
  const h = crypto.scryptSync(pw, user.salt, 64).toString('hex');
  return crypto.timingSafeEqual(Buffer.from(h), Buffer.from(user.hash));
}

class HttpError extends Error {
  constructor(status, msg) { super(msg); this.status = status; }
}
const fail = (status, msg) => { throw new HttpError(status, msg); };

function ratingOf(uid) {
  const rs = db.ratings.filter((r) => r.to === uid);
  const avg = rs.length ? rs.reduce((a, r) => a + r.score, 0) / rs.length : 0;
  return { avg: Math.round(avg * 10) / 10, count: rs.length };
}

function pub(u) {
  if (!u) return null;
  const { id, username, displayName, bio, games, platform, level, schedule, createdAt, avatarZoom, avatarPos, coverZoom, coverPos } = u;
  const avatar = u.avatar && u.avatar.startsWith('i') ? `/api/images/${u.avatar}` : u.avatar;
  const cover = u.cover && u.cover.startsWith('i') ? `/api/images/${u.cover}` : u.cover;
  return { id, username, displayName, bio, avatar, avatarZoom, avatarPos, cover, coverZoom, coverPos, games, platform, level, schedule, createdAt, rating: ratingOf(id) };
}
const pubMini = (u) => {
  if (!u) return null;
  const avatar = u.avatar && u.avatar.startsWith('i') ? `/api/images/${u.avatar}` : u.avatar;
  return { id: u.id, username: u.username, displayName: u.displayName, avatar };
};

function findFriendship(a, b) {
  return db.friendships.find((x) => (x.from === a && x.to === b) || (x.from === b && x.to === a));
}
function friendRel(me, other) {
  if (me === other) return 'self';
  const f = findFriendship(me, other);
  if (!f) return 'none';
  if (f.status === 'accepted') return 'friends';
  return f.from === me ? 'outgoing' : 'incoming';
}
function friendIds(uid) {
  return db.friendships
    .filter((f) => f.status === 'accepted' && (f.from === uid || f.to === uid))
    .map((f) => (f.from === uid ? f.to : f.from));
}
function notify(userId, type, text, data = {}) {
  db.notifications.unshift({ id: nextId('n'), userId, type, text, data, at: Date.now(), read: false });
  if (db.notifications.length > 2000) db.notifications.length = 2000;
}
const dmKey = (a, b) => [a, b].sort().join('|');

function createUser({ username, password, displayName }) {
  const id = nextId('u');
  const { salt, hash } = hashPw(password);
  db.users[id] = {
    id, username, salt, hash, displayName: displayName || username, bio: '',
    avatar: META.avatars[Math.floor(Math.random() * META.avatars.length)],
    avatarZoom: 100, avatarPos: { x: 50, y: 50 },
    cover: null, coverZoom: 100, coverPos: { x: 50, y: 50 },
    games: [], platform: 'PC', level: 'ปานกลาง', schedule: '', createdAt: Date.now(),
    credits: 9999, adFree: true,
  };
  return db.users[id];
}

const routes = [];
function compile(p) {
  const keys = [];
  const src = p.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
  return { re: new RegExp('^' + src + '$'), keys };
}
function on(method, p, handler, open = false) {
  const { re, keys } = compile(p);
  routes.push({ method, re, keys, handler, open });
}

// Auth
on('POST', '/api/auth/register', async ({ body }) => {
  const username = String(body.username || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!/^[a-z0-9_]{3,16}$/.test(username)) fail(400, 'ชื่อผู้ใช้ต้องมี 3-16 ตัว (a-z, 0-9, _)');
  if (password.length < 6) fail(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
  if (Object.values(db.users).some((u) => u.username === username)) fail(409, 'ชื่อผู้ใช้นี้ถูกใช้แล้ว');
  const u = createUser({ username, password, displayName: String(body.displayName || '').trim().slice(0, 24) || username });
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  return { token, user: pub(u) };
}, true);

on('POST', '/api/auth/login', async ({ body }) => {
  const username = String(body.username || '').trim().toLowerCase();
  const u = Object.values(db.users).find((x) => x.username === username);
  if (!u || !checkPw(u, String(body.password || ''))) fail(401, 'ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  const token = crypto.randomBytes(24).toString('hex');
  db.sessions[token] = u.id;
  save();
  return { token, user: pub(u) };
}, true);

on('POST', '/api/auth/logout', async ({ token }) => {
  delete db.sessions[token];
  save();
  return { ok: true };
});

on('GET', '/api/meta', async () => META, true);

// Rooms
on('GET', '/api/rooms', async ({ user, query }) => {
  const game = query.get('game') || '';
  if (!Array.isArray(db.rooms)) db.rooms = [];
  return db.rooms
    .filter((r) => !game || r.game === game)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((r) => ({
      ...r,
      host: pubMini(db.users[r.hostId]),
      members: r.members.map((id) => pubMini(db.users[id])).filter(Boolean),
      count: r.members.length,
      slotsLeft: r.size - r.members.length,
      joined: r.members.includes(user?.id),
    }));
}, true);

on('POST', '/api/rooms', async ({ user, body }) => {
  const game = String(body.game || '');
  if (!META.games.includes(game)) fail(400, 'โปรดเลือกเกมที่ถูกต้อง');
  const title = String(body.title || '').trim().slice(0, 40) || 'หาเพื่อนเล่น';
  const size = Math.min(10, Math.max(2, Number(body.size) || 5));
  const note = String(body.note || '').slice(0, 80);
  
  if (!Array.isArray(db.rooms)) db.rooms = [];

  const r = {
    id: nextId('rm'), game, title, size, note,
    hostId: user.id, members: [user.id], messages: [],
    createdAt: Date.now(), canLeaveAt: Date.now() + 60000,
  };
  db.rooms.unshift(r);
  if (db.rooms.length > 200) db.rooms.pop();
  save();
  return { id: r.id };
});

on('GET', '/api/rooms/:id', async ({ user, params }) => {
  if (!Array.isArray(db.rooms)) db.rooms = [];
  const r = db.rooms.find((x) => x.id === params.id);
  if (!r) fail(404, 'ไม่พบห้องนี้');
  const joined = r.members.includes(user.id);
  const rated = db.ratings.filter((x) => x.from === user.id).map((x) => x.to);
  const unrated = r.members.filter((id) => id !== user.id && !rated.includes(id)).map((id) => pubMini(db.users[id])).filter(Boolean);
  return {
    ...r, host: pubMini(db.users[r.hostId]),
    members: r.members.map((id) => pubMini(db.users[id])).filter(Boolean),
    count: r.members.length, slotsLeft: r.size - r.members.length, joined, unrated,
  };
});

on('POST', '/api/rooms/:id/join', async ({ user, params }) => {
  if (!Array.isArray(db.rooms)) db.rooms = [];
  const r = db.rooms.find((x) => x.id === params.id);
  if (!r) fail(404, 'ไม่พบห้องนี้');
  if (r.members.includes(user.id)) return { ok: true };
  if (r.members.length >= r.size) fail(400, 'ห้องเต็มแล้ว');
  r.members.push(user.id);
  notify(r.hostId, 'room', `${user.displayName} เข้าร่วมห้อง "${r.title}" ของคุณ`);
  save();
  return { ok: true };
});

on('POST', '/api/rooms/:id/leave', async ({ user, params }) => {
  if (!Array.isArray(db.rooms)) db.rooms = [];
  const r = db.rooms.find((x) => x.id === params.id);
  if (!r) fail(404, 'ไม่พบห้องนี้');
  r.members = r.members.filter((m) => m !== user.id);
  if (!r.members.length || r.hostId === user.id) {
    db.rooms = db.rooms.filter((x) => x.id !== r.id);
  }
  save();
  return { ok: true };
});

on('GET', '/api/rooms/:id/messages', async ({ user, params }) => {
  if (!Array.isArray(db.rooms)) db.rooms = [];
  const r = db.rooms.find((x) => x.id === params.id);
  if (!r) fail(404, 'ไม่พบห้องนี้');
  if (!r.members.includes(user.id)) fail(403, 'คุณไม่ได้อยู่ในห้องนี้');
  return (r.messages || []).slice(-200).map((m) => ({
    id: m.id, mine: m.from === user.id, from: pubMini(db.users[m.from]), text: m.text, at: m.at,
  }));
});

on('POST', '/api/rooms/:id/messages', async ({ user, params, body }) => {
  if (!Array.isArray(db.rooms)) db.rooms = [];
  const r = db.rooms.find((x) => x.id === params.id);
  if (!r) fail(404, 'ไม่พบห้องนี้');
  if (!r.members.includes(user.id)) fail(403, 'คุณไม่ได้อยู่ในห้องนี้');
  const text = String(body.text || '').trim().slice(0, 300);
  if (!text) fail(400, 'ข้อความว่างเปล่า');
  const m = { id: nextId('m'), from: user.id, text, at: Date.now() };
  if (!r.messages) r.messages = [];
  r.messages.push(m);
  if (r.messages.length > 500) r.messages = r.messages.slice(-500);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

// Profile / Me
on('GET', '/api/me', async ({ user }) => ({ ...pub(user), isAdmin: !!user.isAdmin, credits: user.credits || 9999, adFree: true }));

on('PUT', '/api/me', async ({ user, body }) => {
  if (body.displayName !== undefined) {
    const v = String(body.displayName).trim().slice(0, 24);
    if (!v) fail(400, 'กรุณาใส่ชื่อที่แสดง');
    user.displayName = v;
  }
  if (body.bio !== undefined) user.bio = String(body.bio).slice(0, 200);
  
  if (body.avatar !== undefined) {
    const parsedImg = parseImage(body.avatar);
    if (parsedImg) {
      const imgId = await saveImage(parsedImg);
      user.avatar = imgId;
    } else if (META.avatars.includes(body.avatar)) {
      user.avatar = body.avatar;
    }
  }
  if (body.avatarZoom !== undefined) user.avatarZoom = Number(body.avatarZoom) || 100;
  if (body.avatarPos !== undefined) user.avatarPos = body.avatarPos;

  if (body.cover !== undefined) {
    const parsedCover = parseImage(body.cover);
    if (parsedCover) {
      const coverId = await saveImage(parsedCover);
      user.cover = coverId;
    } else if (!body.cover) {
      user.cover = null;
    }
  }
  if (body.coverZoom !== undefined) user.coverZoom = Number(body.coverZoom) || 100;
  if (body.coverPos !== undefined) user.coverPos = body.coverPos;

  if (body.games !== undefined) {
    user.games = (Array.isArray(body.games) ? body.games : []).filter((g) => META.games.includes(g)).slice(0, 6);
  }
  if (body.platform !== undefined && META.platforms.includes(body.platform)) user.platform = body.platform;
  if (body.level !== undefined && META.levels.includes(body.level)) user.level = body.level;
  if (body.schedule !== undefined) user.schedule = String(body.schedule).slice(0, 80);
  save();
  return { ...pub(user), isAdmin: !!user.isAdmin, credits: user.credits || 9999 };
});

on('GET', '/api/users', async ({ user, query }) => {
  const q = (query.get('q') || '').trim().toLowerCase();
  const game = query.get('game') || '';
  return Object.values(db.users)
    .filter((u) => u.id !== user.id)
    .filter((u) => !q || u.displayName.toLowerCase().includes(q) || u.username.includes(q))
    .filter((u) => !game || u.games.includes(game))
    .sort((a, b) => ratingOf(b.id).avg - ratingOf(a.id).avg)
    .slice(0, 50)
    .map((u) => ({ ...pub(u), rel: friendRel(user.id, u.id) }));
});

on('GET', '/api/users/:id', async ({ user, params }) => {
  const u = db.users[params.id];
  if (!u) fail(404, 'ไม่พบผู้ใช้');
  if (u.id !== user.id) {
    db.visits.push({ id: nextId('v'), viewer: user.id, target: u.id, at: Date.now() });
    if (db.visits.length > 5000) db.visits = db.visits.slice(-5000);
    save();
  }
  const ratings = db.ratings
    .filter((r) => r.to === u.id)
    .slice(-30)
    .reverse()
    .map((r) => ({ score: r.score, comment: r.comment, at: r.at, from: pubMini(db.users[r.from]) }));
  return { ...pub(u), rel: friendRel(user.id, u.id), ratings };
});

on('POST', '/api/users/:id/rate', async ({ user, params, body }) => {
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  if (target.id === user.id) fail(400, 'ให้คะแนนตัวเองไม่ได้');
  const score = Math.round(Number(body.score));
  if (!(score >= 1 && score <= 5)) fail(400, 'คะแนนต้องอยู่ระหว่าง 1-5');
  const comment = String(body.comment || '').slice(0, 200);
  const existing = db.ratings.find((r) => r.from === user.id && r.to === target.id);
  if (existing) Object.assign(existing, { score, comment, at: Date.now() });
  else db.ratings.push({ id: nextId('r'), from: user.id, to: target.id, score, comment, at: Date.now() });
  notify(target.id, 'rating', `${user.displayName} ให้คะแนน ${score} ดาวแก่คุณ`);
  save();
  return ratingOf(target.id);
});

on('GET', '/api/friends', async ({ user }) => {
  const list = db.friendships.filter((f) => f.from === user.id || f.to === user.id);
  const other = (f) => db.users[f.from === user.id ? f.to : f.from];
  return {
    friends: list.filter((f) => f.status === 'accepted' && other(f)).map((f) => ({ ...pub(other(f)), friendshipId: f.id })),
    incoming: list.filter((f) => f.status === 'pending' && f.to === user.id).map((f) => ({ requestId: f.id, user: pubMini(db.users[f.from]), at: f.createdAt })),
    outgoing: list.filter((f) => f.status === 'pending' && f.from === user.id).map((f) => ({ requestId: f.id, user: pubMini(other(f)) })),
  };
});

on('POST', '/api/friends/request', async ({ user, body }) => {
  const target = db.users[body.userId];
  if (!target || target.id === user.id) fail(400, 'ไม่สามารถส่งคำขอได้');
  const rel = friendRel(user.id, target.id);
  if (rel === 'friends') fail(409, 'เป็นเพื่อนกันอยู่แล้ว');
  if (rel === 'outgoing') fail(409, 'ส่งคำขอไปแล้ว');
  if (rel === 'incoming') {
    findFriendship(user.id, target.id).status = 'accepted';
    notify(target.id, 'friend', `${user.displayName} ตอบรับคำขอเป็นเพื่อนแล้ว`);
    save();
    return { status: 'friends' };
  }
  const f = { id: nextId('f'), from: user.id, to: target.id, status: 'pending', createdAt: Date.now() };
  db.friendships.push(f);
  notify(target.id, 'friend_request', `${user.displayName} ส่งคำขอเป็นเพื่อนถึงคุณ`, { userId: user.id, requestId: f.id });
  save();
  return { status: 'pending' };
});

on('POST', '/api/friends/:id/accept', async ({ user, params }) => {
  const f = db.friendships.find((x) => x.id === params.id && x.to === user.id && x.status === 'pending');
  if (!f) fail(404, 'ไม่พบคำขอ');
  f.status = 'accepted';
  notify(f.from, 'friend', `${user.displayName} ตอบรับคำขอเป็นเพื่อนแล้ว`);
  save();
  return { ok: true };
});

on('DELETE', '/api/friends/:id', async ({ user, params }) => {
  const f = db.friendships.find((x) => x.id === params.id && (x.from === user.id || x.to === user.id));
  if (!f) fail(404, 'ไม่พบรายการ');
  db.friendships = db.friendships.filter((x) => x !== f);
  save();
  return { ok: true };
});

on('GET', '/api/dm', async ({ user }) =>
  friendIds(user.id).map((fid) => {
    const key = dmKey(user.id, fid);
    const msgs = db.dms.filter((m) => dmKey(m.from, m.to) === key);
    const last = msgs[msgs.length - 1];
    const lastRead = (db.reads[user.id] || {})[fid] || 0;
    const unread = msgs.filter((m) => m.from === fid && m.at > lastRead).length;
    return {
      user: pubMini(db.users[fid]),
      last: last ? { text: last.text || (last.image ? '📷 รูปภาพ' : ''), at: last.at, mine: last.from === user.id } : null,
      unread,
    };
  }).sort((a, b) => (b.last?.at || 0) - (a.last?.at || 0)));

on('GET', '/api/dm/:userId', async ({ user, params, token }) => {
  const other = db.users[params.userId];
  if (!other) fail(404, 'ไม่พบผู้ใช้');
  const key = dmKey(user.id, other.id);
  const messages = db.dms.filter((m) => dmKey(m.from, m.to) === key).slice(-200);
  db.reads[user.id] = db.reads[user.id] || {};
  db.reads[user.id][other.id] = Date.now();
  save();
  return {
    user: pub(other), rel: friendRel(user.id, other.id),
    messages: messages.map((m) => ({ id: m.id, mine: m.from === user.id, text: m.text, image: imageUrl(m.image, token), at: m.at })),
  };
});

on('POST', '/api/dm/:userId', async ({ user, params, body }) => {
  const other = db.users[params.userId];
  if (!other) fail(404, 'ไม่พบผู้ใช้');
  if (friendRel(user.id, other.id) !== 'friends') fail(403, 'ต้องเป็นเพื่อนกันก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 500);
  const img = parseImage(body.image);
  if (!text && !img) fail(400, 'ข้อความว่างเปล่า');
  let imageId = null;
  if (img) {
    imageId = await saveImage(img);
  }
  const m = { id: nextId('m'), from: user.id, to: other.id, text, image: imageId, at: Date.now() };
  db.dms.push(m);
  if (db.dms.length > 10000) db.dms = db.dms.slice(-10000);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

on('GET', '/api/visitors', async ({ user }) =>
  db.visits.filter((v) => v.target === user.id).slice(-100).reverse().map((v) => ({ at: v.at, viewer: pubMini(db.users[v.viewer]) })).filter((x) => x.viewer));

on('GET', '/api/groups', async ({ user }) =>
  Object.values(db.groups).map((g) => ({
    id: g.id, name: g.name, game: g.game, description: g.description,
    members: g.members.length, joined: g.members.includes(user.id),
  })));

on('POST', '/api/groups', async ({ user, body }) => {
  const name = String(body.name || '').trim().slice(0, 30);
  if (!name) fail(400, 'กรุณาตั้งชื่อกลุ่ม');
  const g = {
    id: nextId('g'), name,
    game: META.games.includes(body.game) ? body.game : '',
    description: String(body.description || '').slice(0, 120),
    owner: user.id, members: [user.id], messages: [], createdAt: Date.now(),
  };
  db.groups[g.id] = g;
  save();
  return { id: g.id };
});

on('GET', '/api/groups/:id', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  return {
    id: g.id, name: g.name, game: g.game, description: g.description, owner: g.owner,
    joined: g.members.includes(user.id),
    members: g.members.map((id) => pubMini(db.users[id])).filter(Boolean),
  };
});

on('POST', '/api/groups/:id/join', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) g.members.push(user.id);
  save();
  return { ok: true };
});

on('POST', '/api/groups/:id/leave', async ({ user, params }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  g.members = g.members.filter((m) => m !== user.id);
  if (!g.members.length) delete db.groups[g.id];
  save();
  return { ok: true };
});

on('GET', '/api/groups/:id/messages', async ({ user, params, token }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) fail(403, 'เข้าร่วมกลุ่มก่อนจึงจะดูข้อความได้');
  return g.messages.slice(-200).map((m) => ({
    id: m.id, mine: m.from === user.id, from: pubMini(db.users[m.from]),
    text: m.text, image: imageUrl(m.image, token), at: m.at,
  }));
});

on('POST', '/api/groups/:id/messages', async ({ user, params, body }) => {
  const g = db.groups[params.id];
  if (!g) fail(404, 'ไม่พบกลุ่ม');
  if (!g.members.includes(user.id)) fail(403, 'เข้าร่วมกลุ่มก่อนจึงจะส่งข้อความได้');
  const text = String(body.text || '').trim().slice(0, 500);
  const img = parseImage(body.image);
  if (!text && !img) fail(400, 'ข้อความว่างเปล่า');
  let imageId = null;
  if (img) {
    imageId = await saveImage(img);
  }
  const m = { id: nextId('m'), from: user.id, text, image: imageId, at: Date.now() };
  g.messages.push(m);
  if (g.messages.length > 2000) g.messages = g.messages.slice(-2000);
  save();
  return { id: m.id, mine: true, text, at: m.at };
});

on('GET', '/api/images/:id', async ({ params }) => {
  const img = await imageCol.findOne({ _id: params.id });
  if (!img) fail(404, 'ไม่พบรูป');
  const b = img.data;
  const buf = Buffer.isBuffer(b) ? b : Buffer.from(b.buffer).subarray(0, b.position);
  return { __raw: true, mime: img.mime, buf };
}, true);

on('GET', '/api/wallet', async ({ user }) => {
  user.credits = user.credits || 9999;
  return { credits: user.credits, adFree: true, imageCost: 0, adFreeCost: 0, packs: [], mode: 'mock' };
});
on('POST', '/api/wallet/topup', async ({ user, body }) => {
  user.credits = (user.credits || 9999) + 50;
  save();
  return { credits: user.credits };
});
on('POST', '/api/wallet/confirm', async ({ user, body }) => {
  return { credits: user.credits || 9999 };
});
on('POST', '/api/wallet/adfree', async ({ user }) => {
  user.adFree = true;
  save();
  return { credits: user.credits || 9999, adFree: true };
});

on('GET', '/api/match', async ({ user }) => {
  const cutoff = Date.now() - 10 * 60 * 1000;
  db.queue = db.queue.filter((q) => q.at > cutoff);
  const q = db.queue.find((x) => x.userId === user.id);
  const result = db.matchResults[user.id] || null;
  if (result) { delete db.matchResults[user.id]; save(); }
  return { searching: !!q, game: q?.game || null, since: q?.at || null, result };
});

on('POST', '/api/match/start', async ({ user, body }) => {
  const game = String(body.game || '');
  if (!META.games.includes(game)) fail(400, 'กรุณาเลือกเกมก่อน');
  db.queue = db.queue.filter((q) => q.userId !== user.id);
  const partnerQ = db.queue.find((q) => q.game === game && q.userId !== user.id && db.users[q.userId]);
  if (!partnerQ) {
    db.queue.push({ userId: user.id, game, at: Date.now() });
    save();
    return { searching: true, game, since: Date.now(), result: null };
  }
  db.queue = db.queue.filter((q) => q !== partnerQ);
  const match = { id: nextId('x'), game, players: [user.id, partnerQ.userId], at: Date.now() };
  db.matches.push(match);
  if (db.matches.length > 500) db.matches = db.matches.slice(-500);
  const partner = db.users[partnerQ.userId];
  db.matchResults[partner.id] = { match: { id: match.id, game, at: match.at }, partner: pubMini(user) };
  notify(partner.id, 'match', `พบคู่เล่น ${game} กับ ${user.displayName} แล้ว`);
  notify(user.id, 'match', `พบคู่เล่น ${game} กับ ${partner.displayName} แล้ว`);
  save();
  return { searching: false, game, result: { match: { id: match.id, game, at: match.at }, partner: pubMini(partner) } };
});

on('POST', '/api/match/stop', async ({ user }) => {
  db.queue = db.queue.filter((q) => q.userId !== user.id);
  save();
  return { searching: false };
});

on('GET', '/api/matches', async ({ user }) =>
  db.matches.filter((m) => m.players.includes(user.id)).slice(-50).reverse().map((m) => ({
    id: m.id, game: m.game, at: m.at, partner: pubMini(db.users[m.players.find((p) => p !== user.id)]),
  })));

on('GET', '/api/notifications', async ({ user }) => {
  const mine = db.notifications.filter((n) => n.userId === user.id);
  return { items: mine.slice(0, 100), unread: mine.filter((n) => !n.read).length };
});

on('GET', '/api/notifications/count', async ({ user }) => ({
  unread: db.notifications.filter((n) => n.userId === user.id && !n.read).length,
}));

on('POST', '/api/notifications/read', async ({ user }) => {
  db.notifications.forEach((n) => { if (n.userId === user.id) n.read = true; });
  save();
  return { ok: true };
});

const requireAdmin = (user) => { if (!user?.isAdmin) fail(403, 'เฉพาะผู้ดูแลระบบ'); };

on('GET', '/api/admin/stats', async ({ user }) => {
  requireAdmin(user);
  return {
    users: Object.keys(db.users).length,
    friendships: db.friendships.filter((f) => f.status === 'accepted').length,
    messages: db.dms.length + Object.values(db.groups).reduce((a, g) => a + g.messages.length, 0),
    groups: Object.keys(db.groups).length,
  };
});

on('GET', '/api/admin/users', async ({ user }) => {
  requireAdmin(user);
  return Object.values(db.users)
    .map((u) => ({ id: u.id, username: u.username, displayName: u.displayName, credits: u.credits || 9999, adFree: true, isAdmin: !!u.isAdmin, createdAt: u.createdAt }))
    .sort((a, b) => b.createdAt - a.createdAt);
});

on('POST', '/api/admin/users/:id/credits', async ({ user, params, body }) => {
  requireAdmin(user);
  const target = db.users[params.id];
  if (!target) fail(404, 'ไม่พบผู้ใช้');
  const amount = Math.round(Number(body.amount));
  if (!Number.isFinite(amount)) fail(400, 'จำนวนไม่ถูกต้อง');
  target.credits = (target.credits || 0) + amount;
  save();
  return { credits: target.credits };
});

on('DELETE', '/api/admin/users/:id', async ({ user, params }) => {
  requireAdmin(user);
  if (params.id === user.id) fail(400, 'ลบบัญชีของตัวเองไม่ได้');
  if (!db.users[params.id]) fail(404, 'ไม่พบผู้ใช้');
  delete db.users[params.id];
  db.friendships = db.friendships.filter((f) => f.from !== params.id && f.to !== params.id);
  for (const t of Object.keys(db.sessions)) if (db.sessions[t] === params.id) delete db.sessions[t];
  for (const g of Object.values(db.groups)) g.members = g.members.filter((m) => m !== params.id);
  save();
  return { ok: true };
});

on('POST', '/api/admin/announce', async ({ user, body }) => {
  requireAdmin(user);
  const text = String(body.text || '').trim().slice(0, 200);
  if (!text) fail(400, 'กรุณาใส่ข้อความประกาศ');
  const ids = Object.keys(db.users);
  for (const id of ids) notify(id, 'announce', `📢 ${text}`);
  save();
  return { sent: ids.length };
});

on('POST', '/api/admin/password', async ({ user, body }) => {
  requireAdmin(user);
  const pw = String(body.password || '');
  if (pw.length < 6) fail(400, 'รหัสผ่านต้องมีอย่างน้อย 6 ตัว');
  Object.assign(user, hashPw(pw));
  save();
  return { ok: true };
});

function send(res, status, obj) {
  if (obj && obj.__raw) {
    res.writeHead(status, { 'Content-Type': obj.mime, 'Cache-Control': 'private, max-age=86400' });
    return res.end(obj.buf);
  }
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', (c) => {
      d += c;
      if (d.length > 3e6) { req.destroy(); reject(new HttpError(413, 'ข้อมูลใหญ่เกินไป')); }
    });
    req.on('end', () => {
      if (!d) return resolve({});
      try { resolve(JSON.parse(d)); } catch { reject(new HttpError(400, 'รูปแบบข้อมูลไม่ถูกต้อง')); }
    });
    req.on('error', reject);
  });
}

async function handleApi(req, res, url) {
  const route = routes.find((r) => r.method === req.method && r.re.test(url.pathname));
  if (!route) fail(404, 'ไม่พบ API นี้');
  const m = url.pathname.match(route.re);
  const params = {};
  route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });

  let user = null;
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '') || url.searchParams.get('t') || '';
  if (!route.open) {
    const uid = db.sessions[token];
    if (!uid || !db.users[uid]) fail(401, 'กรุณาเข้าสู่ระบบใหม่');
    user = db.users[uid];
  } else {
    const uid = db.sessions[token];
    if (uid && db.users[uid]) user = db.users[uid];
  }
  const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
  const result = await route.handler({ body, params, user, token, query: url.searchParams });
  send(res, 200, result);
}

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
};

function serveStatic(p, res) {
  const file = path.join(PUBLIC_DIR, p === '/' ? 'index.html' : p);
  if (!file.startsWith(PUBLIC_DIR)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) {
      return fs.readFile(path.join(PUBLIC_DIR, 'index.html'), (e2, d2) => {
        if (e2) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': MIME['.html'] });
        res.end(d2);
      });
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  try {
    if (url.pathname.startsWith('/api/')) return await handleApi(req, res, url);
    return serveStatic(url.pathname, res);
  } catch (e) {
    if (e.status) return send(res, e.status, { error: e.message });
    console.error(e);
    return send(res, 500, { error: 'เกิดข้อผิดพลาดที่เซิร์ฟเวอร์' });
  }
});

function seed() {
  if (Object.keys(db.users).length) return;
  const demos = [
    ['demo1', 'ฟ้า', ['APEX Legends', 'Valorant'], 'เสาร์-อาทิตย์ 19:00-22:00', 'เก่ง', '🐱'],
    ['demo2', 'ปลาย', ['Minecraft', 'Among Us'], 'ทุกวัน 20:00-23:00', 'เริ่มต้น', '🦊'],
    ['demo3', 'บอส', ['League of Legends', 'Overwatch 2'], 'จันทร์-ศุกร์ 18:00-21:00', 'สายโปร', '🐯'],
    ['demo4', 'มินท์', ['Genshin Impact'], 'เสาร์ 14:00-17:00', 'ปานกลาง', '🐼'],
    ['demo5', 'เอ็ม', ['Fortnite', 'APEX Legends'], 'อาทิตย์ 10:00-13:00', 'ปานกลาง', '🐸'],
  ];
  for (const [username, displayName, games, schedule, level, avatar] of demos) {
    const u = createUser({ username, password: 'demo1234', displayName });
    Object.assign(u, { games, schedule, level, avatar, bio: 'ยินดีที่ได้รู้จักทุกคน!' });
  }
  const ids = Object.keys(db.users);
  db.ratings.push({ id: nextId('r'), from: ids[1], to: ids[0], score: 5, comment: 'เล่นสนุกมาก', at: Date.now() });
  save();
}

function ensureAdmin() {
  if (Object.values(db.users).some((u) => u.isAdmin)) return;
  if (Object.values(db.users).some((u) => u.username === 'admin')) return;
  const pw = process.env.ADMIN_PASSWORD || 'admin1234';
  const u = createUser({ username: 'admin', password: pw, displayName: 'ผู้ดูแลระบบ' });
  u.isAdmin = true;
  u.credits = 999999;
  save();
}

async function main() {
  if (!MONGODB_URI) {
    console.error('ยังไม่ได้ตั้งค่า MONGODB_URI');
    process.exit(1);
  }
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  const mdb = client.db(DB_NAME);
  stateCol = mdb.collection('state');
  imageCol = mdb.collection('images');
  await loadDb();
  seed();
  ensureAdmin();
  await flush();
  server.listen(PORT, () => console.log(`GameBuddy running on port ${PORT}`));
}

main().catch((e) => {
  console.error('เริ่มเซิร์ฟเวอร์ไม่สำเร็จ:', e.message);
  process.exit(1);
});
let tableReady;

async function ensureTable(env) {
  if (!tableReady) {
    tableReady = env.DB.prepare(`CREATE TABLE IF NOT EXISTS ifa_bookings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      team TEXT NOT NULL,
      date TEXT NOT NULL,
      time TEXT NOT NULL,
      name TEXT NOT NULL,
      company TEXT NOT NULL,
      whatsapp TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      createdAt TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`).run().catch(err => { tableReady = null; throw err; });
  }
  return tableReady;
}

export async function handleIFABookingCreate(request, env) {
  await ensureTable(env);
  const body = await request.json().catch(() => ({}));
  const team     = String(body.team     || '').trim();
  const date     = String(body.date     || '').trim();
  const time     = String(body.time     || '').trim();
  const name     = String(body.name     || '').trim();
  const company  = String(body.company  || '').trim();
  const whatsapp = String(body.whatsapp || '').trim();
  const note     = String(body.note     || '').trim();

  if (!team || !date || !time || !name || !company || !whatsapp) {
    return Response.json({ error: 'Missing required fields.' }, { status: 400 });
  }

  const result = await env.DB.prepare(
    'INSERT INTO ifa_bookings (team,date,time,name,company,whatsapp,note) VALUES (?,?,?,?,?,?,?)'
  ).bind(team, date, time, name, company, whatsapp, note).run();

  return Response.json({ success: true, id: result.meta?.last_row_id });
}

export async function handleIFABookingList(request, env) {
  await ensureTable(env);
  const email = (request.headers.get('Cf-Access-Authenticated-User-Email') || '').trim().toLowerCase();
  const user = email ? await env.DB.prepare('SELECT role FROM users WHERE email=?').bind(email).first() : null;
  if (!user || user.role !== 'Administrator') {
    return Response.json({ error: 'Administrator access required.' }, { status: 403 });
  }
  const { results } = await env.DB.prepare(
    'SELECT * FROM ifa_bookings ORDER BY createdAt DESC'
  ).all();
  return Response.json({ bookings: results || [] });
}

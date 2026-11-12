(() => {
  const config = window.SUPABASE_CONFIG;
  const clientFactory = window.supabase && window.supabase.createClient;
  let ready = false;
  let authError = "";
  let baseline = null;
  let writeQueue = Promise.resolve();
  let authListener;

  if (!config || !clientFactory) {
    ready = true;
    authError = "Supabase could not be loaded. Check the project configuration and network connection.";
    window.render = () => {
      document.querySelector("#app").innerHTML = auth();
    };
    render();
    return;
  }

  const client = clientFactory(config.url, config.publishableKey, {
    auth: { autoRefreshToken: true, persistSession: true, detectSessionInUrl: true }
  });
  window.supabaseClient = client;

  const copy = value => JSON.parse(JSON.stringify(value));
  const stateCopy = () => copy({
    users: DB.users,
    rooms: DB.rooms,
    equipment: DB.equipment,
    timeslots: DB.timeslots,
    bookings: DB.bookings,
    schedules: DB.schedules,
    logs: DB.logs,
    messages: DB.messages
  });
  const fail = error => {
    if (error) throw error;
  };
  const rows = async query => {
    const { data, error } = await query;
    fail(error);
    return data || [];
  };
  const one = async query => {
    const { data, error } = await query;
    fail(error);
    return data;
  };
  const remoteId = row => row.cloud_id || row.id;
  const byId = list => new Map(list.map(row => [String(remoteId(row)), row]));
  const changed = (a, b) => JSON.stringify(a) !== JSON.stringify(b);
  const timeId = label => DB.timeslots.find(slot => slot.label === label)?.id;
  const profileByUsername = username => DB.users.find(user => user.username === username);
  const dayNumber = day => ({ Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 })[day];
  const dayName = number => ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][number] || "Mon";
  const iso = value => value ? new Date(value).toISOString() : null;
  const profilePayload = user => ({
    full_name: user.name,
    contact_email: user.email || null,
    phone: user.phone || null,
    birthdate: user.birthdate || null,
    gender: user.gender || null,
    id_number: user.idno || null,
    department: user.dept || null,
    year_section: user.year || null,
    street_address: user.address || null,
    city: user.city || null,
    province: user.province || null,
    zip_code: user.zip || null,
    emergency_contact_name: user.ecname || null,
    emergency_contact_phone: user.ecphone || null,
    emergency_contact_relationship: user.ecrel || null,
    avatar_path: user.avatar_path || null
  });
  const roomPayload = room => ({
    id: room.id,
    name: room.name,
    category: room.category,
    room_type: room.type,
    capacity: room.capacity,
    floor: room.floor,
    facilities: String(room.facilities || "").split(",").map(item => item.trim()).filter(Boolean),
    is_active: room.is_active !== false
  });
  const equipmentPayload = item => ({
    id: item.id,
    name: item.name,
    category: item.category,
    quantity: item.qty,
    is_active: item.is_active !== false
  });
  const bookingPayload = booking => ({
    id: remoteId(booking),
    user_id: booking.user_id || profileByUsername(booking.username)?.id || me.id,
    room_id: booking.room_id,
    booking_date: booking.date,
    time_slot_id: timeId(booking.slot),
    purpose: booking.purpose,
    status: booking.status
  });
  const schedulePayload = schedule => ({
    id: remoteId(schedule),
    teacher_id: schedule.teacher_id || profileByUsername(schedule.username)?.id || me.id,
    subject: schedule.subject,
    section: schedule.section || "",
    day_of_week: dayNumber(schedule.day),
    time_slot_id: timeId(schedule.slot),
    room_id: schedule.room_id || null
  });
  const messagePayload = message => {
    const recipient = profileByUsername(message.to);
    const booking = DB.bookings.find(item => String(item.id) === String(message.booking_id));
    const splitAt = String(message.body || "").indexOf(" - ");
    return {
      id: remoteId(message),
      booking_id: message.booking_cloud_id || booking?.cloud_id || message.booking_id,
      recipient_id: recipient?.id,
      reported_by: me.id,
      severity: message.severity,
      damaged_item: splitAt < 0 ? "Other" : message.body.slice(0, splitAt),
      details: splitAt < 0 ? String(message.body || "") : message.body.slice(splitAt + 3),
      reported_on: message.date || today(),
      is_read: !!message.read,
      acknowledged_at: message.ack ? iso(message.ackts || Date.now()) : null
    };
  };

  async function loadCatalog() {
    const [roomRows, equipmentRows, slotRows] = await Promise.all([
      rows(client.from("rooms").select("*").order("id")),
      rows(client.from("equipment").select("*").order("id")),
      rows(client.from("time_slots").select("*").order("sort_order"))
    ]);
    DB.rooms = roomRows.map(room => ({
      id: Number(room.id), name: room.name, category: room.category,
      type: room.room_type, capacity: room.capacity, floor: room.floor,
      facilities: (room.facilities || []).join(","), is_active: room.is_active
    }));
    DB.equipment = equipmentRows.map(item => ({
      id: Number(item.id), name: item.name, category: item.category,
      qty: item.quantity, is_active: item.is_active
    }));
    DB.timeslots = slotRows.map(slot => ({ id: slot.id, label: slot.label }));
  }

  async function loadWorkspace(user) {
    const [profileRows, bookingRows, equipmentLinks, scheduleRows, reportRows, logRows] = await Promise.all([
      rows(client.from("profiles").select("*").order("created_at")),
      rows(client.from("bookings").select("*")),
      rows(client.from("booking_equipment").select("booking_id,equipment_id")),
      rows(client.from("teacher_schedules").select("*")),
      rows(client.from("damage_reports").select("*")),
      rows(client.from("activity_logs").select("*").order("created_at", { ascending: false }).limit(300))
    ]);

    const avatarEntries = await Promise.all(profileRows.map(async profile => {
      if (!profile.avatar_path) return [profile.id, ""];
      const { data, error } = await client.storage.from("profile-avatars").createSignedUrl(profile.avatar_path, 3600);
      return [profile.id, error ? "" : data.signedUrl];
    }));
    const avatars = new Map(avatarEntries);
    DB.users = profileRows.map(profile => ({
      id: profile.id, username: profile.username, name: profile.full_name,
      role: profile.role, email: profile.contact_email || "", auth_email: profile.auth_email,
      created: String(profile.created_at || "").slice(0, 10), active: profile.is_active,
      phone: profile.phone || "", birthdate: profile.birthdate || "", gender: profile.gender || "",
      idno: profile.id_number || "", dept: profile.department || "", year: profile.year_section || "",
      address: profile.street_address || "", city: profile.city || "", province: profile.province || "",
      zip: profile.zip_code || "", ecname: profile.emergency_contact_name || "",
      ecphone: profile.emergency_contact_phone || "", ecrel: profile.emergency_contact_relationship || "",
      avatar_path: profile.avatar_path || "", avatar: avatars.get(profile.id) || ""
    }));
    const users = byId(DB.users);
    const slots = byId(DB.timeslots);
    const requestedEquipment = new Map();
    equipmentLinks.forEach(link => {
      const list = requestedEquipment.get(String(link.booking_id)) || [];
      const item = DB.equipment.find(equipment => Number(equipment.id) === Number(link.equipment_id));
      if (item) list.push(item.name);
      requestedEquipment.set(String(link.booking_id), list);
    });
    DB.bookings = bookingRows.map((booking, index) => ({
      id: index + 1, cloud_id: booking.id, user_id: booking.user_id,
      username: users.get(String(booking.user_id))?.username || "unknown",
      room_id: Number(booking.room_id), date: booking.booking_date,
      slot: slots.get(String(booking.time_slot_id))?.label || "",
      equipment: (requestedEquipment.get(String(booking.id)) || []).join(", "),
      purpose: booking.purpose, status: booking.status,
      ts: Date.parse(booking.created_at), upd: Date.parse(booking.updated_at)
    }));
    DB.schedules = scheduleRows.map((schedule, index) => ({
      id: index + 1, cloud_id: schedule.id, teacher_id: schedule.teacher_id,
      username: users.get(String(schedule.teacher_id))?.username || "unknown",
      subject: schedule.subject, section: schedule.section,
      day: dayName(schedule.day_of_week),
      slot: slots.get(String(schedule.time_slot_id))?.label || "",
      room_id: schedule.room_id == null ? null : Number(schedule.room_id)
    }));
    DB.messages = reportRows.map((report, index) => {
      const booking = DB.bookings.find(item => String(item.cloud_id) === String(report.booking_id));
      return {
        id: index + 1, cloud_id: report.id, to: users.get(String(report.recipient_id))?.username || "unknown",
        from: "Admin", type: "Damage",
        subject: "Damage reported in " + (DB.rooms.find(room => room.id === Number(booking?.room_id))?.name || "classroom"),
        body: report.damaged_item + " - " + report.details, severity: report.severity,
        room_id: Number(booking?.room_id || 0), booking_id: booking?.id,
        booking_cloud_id: report.booking_id,
        date: report.reported_on, read: report.is_read ? 1 : 0,
        ack: report.acknowledged_at ? 1 : 0,
        ts: Date.parse(report.created_at), ackts: report.acknowledged_at ? Date.parse(report.acknowledged_at) : 0
      };
    });
    DB.logs = logRows.map(log => ({
      id: log.id, time: log.created_at,
      username: users.get(String(log.actor_id))?.username || "-", action: log.action
    }));
    me = DB.users.find(profile => profile.id === user.id) || null;
    if (!me || !me.active) throw new Error("This account is inactive or its profile is not ready. Contact the administrator.");
    baseline = stateCopy();
  }

  async function syncProfiles(next, previous) {
    const old = byId(previous.users);
    for (const profile of next.users) {
      const prior = old.get(String(profile.id));
      if (prior && changed(profilePayload(profile), profilePayload(prior))) {
        const { error } = await client.from("profiles").update(profilePayload(profile)).eq("id", profile.id);
        fail(error);
      }
    }
    const currentIds = new Set(next.users.map(profile => String(profile.id)));
    for (const profile of previous.users) {
      if (!currentIds.has(String(profile.id))) {
        const { error } = await client.from("profiles").update({ is_active: false }).eq("id", profile.id);
        fail(error);
      }
    }
  }

  async function syncTable(table, nextRows, oldRows, payloadFor) {
    const old = byId(oldRows);
    for (const row of nextRows) {
      const prior = old.get(String(remoteId(row)));
      const payload = payloadFor(row);
      if (!prior) {
        const { error } = await client.from(table).insert(payload);
        fail(error);
      } else if (changed(payload, payloadFor(prior))) {
        const { error } = await client.from(table).update(payload).eq("id", remoteId(row));
        fail(error);
      }
    }
    const currentIds = new Set(nextRows.map(row => String(remoteId(row))));
    for (const row of oldRows) {
      if (!currentIds.has(String(remoteId(row)))) {
        const { error } = await client.from(table).delete().eq("id", remoteId(row));
        fail(error);
      }
    }
  }

  async function syncBookings(next, previous) {
    const old = byId(previous.bookings);
    for (const booking of next.bookings) {
      const prior = old.get(String(remoteId(booking)));
      const payload = bookingPayload(booking);
      if (!payload.time_slot_id) throw new Error("The selected time slot is missing from Supabase.");
      const query = prior
        ? client.from("bookings").update(payload).eq("id", remoteId(booking))
        : client.from("bookings").insert(payload);
      const { error } = await query;
      fail(error);
      if (!prior || changed(booking.equipment, prior.equipment)) {
        const { error: deleteError } = await client.from("booking_equipment").delete().eq("booking_id", remoteId(booking));
        fail(deleteError);
        const selected = String(booking.equipment || "").split(",").map(name => name.trim()).filter(Boolean);
        const links = selected.map(name => DB.equipment.find(item => item.name === name)).filter(Boolean)
          .map(item => ({ booking_id: remoteId(booking), equipment_id: item.id }));
        if (links.length) {
          const { error: insertError } = await client.from("booking_equipment").insert(links);
          fail(insertError);
        }
      }
    }
    const currentIds = new Set(next.bookings.map(booking => String(remoteId(booking))));
    for (const booking of previous.bookings) {
      if (!currentIds.has(String(remoteId(booking)))) {
        const { error } = await client.from("bookings").delete().eq("id", remoteId(booking));
        fail(error);
      }
    }
  }

  async function syncMessages(next, previous) {
    const old = byId(previous.messages);
    for (const message of next.messages) {
      const prior = old.get(String(remoteId(message)));
      if (!prior) {
        const { error } = await client.from("damage_reports").insert(messagePayload(message));
        fail(error);
      } else if (message.read !== prior.read || message.ack !== prior.ack || message.ackts !== prior.ackts) {
        const patch = {
          is_read: !!message.read,
          acknowledged_at: message.ack ? iso(message.ackts || Date.now()) : null
        };
        const { error } = await client.from("damage_reports").update(patch).eq("id", remoteId(message));
        fail(error);
      }
    }
    const currentIds = new Set(next.messages.map(message => String(remoteId(message))));
    for (const message of previous.messages) {
      if (!currentIds.has(String(remoteId(message)))) {
        const { error } = await client.from("damage_reports").delete().eq("id", remoteId(message));
        fail(error);
      }
    }
  }

  async function syncLogs(next, previous) {
    const old = byId(previous.logs);
    const currentIds = new Set(next.logs.map(log => String(log.id)));
    for (const log of next.logs) {
      if (!old.has(String(log.id))) {
        const actor = profileByUsername(log.username);
        const { error } = await client.from("activity_logs").insert({
          id: log.id, actor_id: actor?.id || me.id, action: log.action,
          created_at: iso(log.time) || new Date().toISOString()
        });
        if (error && error.code !== "23505") fail(error);
      }
    }
    for (const log of previous.logs) {
      if (!currentIds.has(String(log.id))) {
        const { error } = await client.from("activity_logs").delete().eq("id", log.id);
        fail(error);
      }
    }
  }

  async function persist(target) {
    if (!baseline) throw new Error("Supabase data is not loaded yet.");
    const previous = baseline;
    await syncProfiles(target, previous);
    await syncTable("rooms", target.rooms, previous.rooms, roomPayload);
    await syncTable("equipment", target.equipment, previous.equipment, equipmentPayload);
    await syncBookings(target, previous);
    await syncTable("teacher_schedules", target.schedules, previous.schedules, schedulePayload);
    await syncMessages(target, previous);
    await syncLogs(target, previous);
    baseline = copy(target);
  }

  window.save = function () {
    if (!ready || !me || !baseline) return Promise.resolve(false);
    const target = stateCopy();
    const task = writeQueue.then(() => persist(target));
    writeQueue = task.catch(() => {});
    return task.catch(async error => {
      console.error("Supabase save failed", error);
      try {
        const { data } = await client.auth.getUser();
        if (data.user) {
          await loadCatalog();
          await loadWorkspace(data.user);
        }
      } catch (recoveryError) {
        console.error("Supabase state refresh failed", recoveryError);
      }
      render();
      toast(error.message || "Could not save changes to Supabase.", "e");
      return false;
    });
  };

  const oldShell = window.shell;
  window.shell = function () {
    return oldShell().replace("Database (SQL)", "Database status");
  };
  window.render = function () {
    const app = document.querySelector("#app");
    if (!ready) {
      app.innerHTML = '<div class="authbg"><div class="authc"><section class="card acard"><h2>Connecting to Supabase...</h2></section></div></div>';
      return;
    }
    app.innerHTML = me ? shell() : auth();
  };
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", function () {
      window.render();
    }, { once: true });
  } else {
    window.render();
  }
  window.auth = function () {
    if (!agreed) return terms();
    const registering = authMode === "register";
    return `<div class="authbg"><div class="authc">${head}
      <section class="card acard"><h2 style="text-align:center">${registering ? "Create an account" : "Welcome back"}</h2>
      <div class="tabs"><button class="${registering ? "" : "on"}" onclick="authMode='login';render()">Login</button><button class="${registering ? "on" : ""}" onclick="authMode='register';render()">Register</button></div>
      ${registering ? `<label>Role</label><select id="role"><option>Student</option><option>Teacher</option><option>Other</option></select><label>Full name</label><input id="name" autocomplete="name">` : ""}
      <label>Email</label><input id="email" type="email" autocomplete="email" required>
      ${registering ? `<label>Username</label><input id="user" autocomplete="username">` : ""}
      <label>Password</label><div class="pw"><input id="pass" type="password" autocomplete="${registering ? "new-password" : "current-password"}" onkeydown="if(event.key==='Enter')${registering ? "doReg()" : "doLogin()"}"><button type="button" onclick="eye(this)">Show</button></div>
      <button style="width:100%;margin-top:16px" onclick="${registering ? "doReg()" : "doLogin()"}">${registering ? "Create account" : "Log in"}</button>
      <div class="amsg" id="amsg">${esc(authError)}</div>
      <p class="mu" style="text-align:center">${registering ? "Use a valid email address. Passwords must be at least 8 characters." : "Sign in with the email address used when registering."}</p>
      <p style="text-align:center;margin-top:8px"><a href="#" onclick="reread();return false" style="color:var(--pr);font-size:.85rem">📄 Read the terms again</a></p></section>
      <p class="foot">© City College of Davao · Reserve · Learn · Achieve</p></div></div>`;
  };

  window.doReg = async function () {
    const email = $("#email").value.trim().toLowerCase();
    const name = $("#name").value.trim();
    const username = $("#user").value.trim();
    const password = $("#pass").value;
    const role = $("#role").value;
    if (!name || !email || !/^[A-Za-z0-9._-]{3,30}$/.test(username) || password.length < 8) {
      return afail("Enter a name, valid email, 3-30 character username, and password with at least 8 characters.");
    }
    const { data, error } = await client.auth.signUp({
      email, password, options: { data: { username, full_name: name, role } }
    });
    if (error) return afail(error.message);
    authError = "";
    authMode = "login";
    render();
    if (data.session) await activateSession(data.user);
    else toast("Account created. Check your email to confirm it before signing in.");
  };

  window.doLogin = async function () {
    const email = $("#email").value.trim().toLowerCase();
    const password = $("#pass").value;
    if (!email || !password) return afail("Enter your email and password.");
    const { data, error } = await client.auth.signInWithPassword({ email, password });
    if (error) return afail(error.message);
    try {
      await activateSession(data.user);
    } catch (loadError) {
      await client.auth.signOut();
      authError = loadError.message || "Could not load your Supabase profile.";
      render();
    }
  };

  async function activateSession(user) {
    await loadCatalog();
    await loadWorkspace(user);
    authError = "";
    ready = true;
    page = me.role === "Admin" ? "admin" : "home";
    logA("Logged in");
    render();
    await window.save();
    const unread = DB.messages.filter(message => message.to === me.username && !message.read).length;
    toast(unread ? `You have ${unread} new message${unread > 1 ? "s" : ""} from the admin` : `Welcome, ${me.name}!`);
  }

  window.logout = async function () {
    if (me) {
      logA("Logged out");
      await window.save();
    }
    const { error } = await client.auth.signOut();
    if (error) toast(error.message, "e");
    me = null;
    DB = seed();
    DB.users = [];
    baseline = null;
    page = "home";
    render();
  };

  window.changePassword = async function () {
    const password = $("#p1").value;
    if (password.length < 8) return toast("New password needs at least 8 characters.", "e");
    const { error } = await client.auth.updateUser({ password });
    if (error) return toast(error.message, "e");
    $("#p1").value = "";
    toast("Password changed.");
  };

  window.users = function () {
    const list = DB.users;
    return `<div class="card"><h3>Accounts</h3><div class="tw"><table><tr><th>Name</th><th>Username</th><th>Email</th><th>Role</th><th>Created</th><th>Status</th><th></th></tr>${list.map(user => `<tr><td>${esc(user.name)}</td><td>${esc(user.username)}</td><td>${esc(user.auth_email)}</td><td>${esc(user.role)}</td><td>${esc(user.created)}</td><td>${user.active ? "Active" : "Inactive"}</td><td>${user.role !== "Admin" && user.active ? `<button class="sm er" onclick="deactivateUser('${user.id}')">Deactivate</button>` : ""}</td></tr>`).join("")}</table></div></div>`;
  };
  window.deactivateUser = async function (id) {
    const user = DB.users.find(row => row.id === id);
    if (!user || user.role === "Admin" || !confirm(`Deactivate ${user.username}?`)) return;
    DB.users = DB.users.filter(row => row.id !== id);
    logA("Deactivated account " + user.username);
    const saved = await window.save();
    if (saved) {
      render();
      toast("Account deactivated.");
    }
  };
  window.account = function () {
    return `${profileCard()}${secCard()}`;
  };
  window.db = function () {
    return `<div class="card"><h3>Supabase database</h3><p class="mu">This app uses row-level security. Direct SQL execution from the browser is disabled.</p><div class="tw"><table><tr><th>Table</th><th>Loaded rows</th></tr>${[["profiles", DB.users.length], ["rooms", DB.rooms.length], ["equipment", DB.equipment.length], ["time_slots", DB.timeslots.length], ["bookings", DB.bookings.length], ["teacher_schedules", DB.schedules.length], ["damage_reports", DB.messages.length], ["activity_logs", DB.logs.length]].map(row => `<tr><td>${row[0]}</td><td>${row[1]}</td></tr>`).join("")}</table></div></div>`;
  };
  window.runSql = () => toast("Browser SQL execution is disabled. Manage the schema in Supabase SQL Editor.", "e");
  const previousReply = window.reply;
  window.reply = function (question) {
    if (/admin|sql|database/.test(question)) {
      return ["Administrators manage accounts and reservations in the app. Database schema changes are managed securely in the Supabase Dashboard."];
    }
    return previousReply(question);
  };

  window.submitB = async function () {
    const form = bf;
    if (!form.slot || !form.purpose.trim()) return toast("Pick an available slot and enter a purpose.", "e");
    if (taken(form.room, form.date, form.slot)) return toast("That slot was just taken.", "e");
    DB.bookings.push({
      id: Math.max(0, ...DB.bookings.map(booking => Number(booking.id) || 0)) + 1,
      cloud_id: crypto.randomUUID(), user_id: me.id, username: me.username,
      room_id: form.room, date: form.date, slot: form.slot,
      equipment: form.eq.join(", "), purpose: form.purpose.trim(),
      status: me.role === "Admin" ? "Approved" : "Pending", ts: Date.now()
    });
    logA("Reserved " + room(form.room).name + " on " + form.date + " " + form.slot);
    const saved = await window.save();
    if (!saved) return;
    bf = null;
    toast("Reservation submitted.");
    go(me.role === "Admin" ? "all" : "mine");
  };

  window.addSched = async function () {
    const subject = sf.subject.trim();
    if (!subject || !sf.slot) return toast("Enter a subject and choose a time slot.", "e");
    if (DB.schedules.some(row => row.username === me.username && row.day === sf.day && row.slot === sf.slot)) {
      return toast("You already have a class at that day and time.", "e");
    }
    const roomId = sf.room ? Number(sf.room) : null;
    if (roomId && DB.schedules.some(row => row.room_id === roomId && row.day === sf.day && row.slot === sf.slot)) {
      return toast("That room is already used by another class then.", "e");
    }
    DB.schedules.push({
      id: Math.max(0, ...DB.schedules.map(schedule => Number(schedule.id) || 0)) + 1,
      cloud_id: crypto.randomUUID(), teacher_id: me.id, username: me.username,
      subject, section: sf.section.trim(), day: sf.day, slot: sf.slot, room_id: roomId
    });
    const saved = await window.save();
    if (!saved) return;
    sf.subject = "";
    sf.section = "";
    toast("Subject added to your schedule.");
    render();
  };

  window.sendDmg = async function () {
    const booking = DB.bookings.find(row => String(row.id) === String(dmg));
    const details = $("#dtx").value.trim();
    if (!booking || !details) return toast("Describe the damage first.", "e");
    DB.messages.push({
      id: Math.max(0, ...DB.messages.map(message => Number(message.id) || 0)) + 1,
      cloud_id: crypto.randomUUID(), booking_cloud_id: booking.cloud_id,
      to: booking.username, from: "Admin", type: "Damage",
      subject: "Damage reported in " + room(booking.room_id).name,
      body: $("#dit").value + " - " + details, severity: $("#dsv").value,
      room_id: booking.room_id, booking_id: booking.id, date: today(),
      ts: Date.now(), read: 0, ack: 0
    });
    logA("Damage report sent to " + booking.username + " (" + room(booking.room_id).name + ")");
    const saved = await window.save();
    if (!saved) return;
    dmg = null;
    render();
    toast("Damage report sent to the user.");
  };

  window.uploadPhoto = async function (input) {
    const file = input.files && input.files[0];
    if (!file || !/^image\//.test(file.type)) return toast("Please choose an image file.", "e");
    try {
      const blob = await resizeImage(file);
      const path = `${me.id}/avatar.jpg`;
      const { error } = await client.storage.from("profile-avatars").upload(path, blob, { upsert: true, contentType: "image/jpeg" });
      fail(error);
      me.avatar_path = path;
      const saved = await window.save();
      if (!saved) return;
      const { data, error: signedError } = await client.storage.from("profile-avatars").createSignedUrl(path, 3600);
      fail(signedError);
      me.avatar = data.signedUrl;
      render();
      toast("Profile photo updated.");
    } catch (error) {
      toast(error.message || "Could not upload that photo.", "e");
    }
  };
  window.removePhoto = async function () {
    const path = me.avatar_path;
    me.avatar_path = "";
    me.avatar = "";
    const saved = await window.save();
    if (!saved) return;
    if (path) {
      const { error } = await client.storage.from("profile-avatars").remove([path]);
      if (error) return toast(error.message, "e");
    }
    render();
    toast("Profile photo removed.");
  };

  function resizeImage(file) {
    return new Promise((resolve, reject) => {
      const source = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const size = 256;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const context = canvas.getContext("2d");
        const crop = Math.min(image.width, image.height);
        context.fillStyle = "#fff";
        context.fillRect(0, 0, size, size);
        context.drawImage(image, (image.width - crop) / 2, (image.height - crop) / 2, crop, crop, 0, 0, size, size);
        URL.revokeObjectURL(source);
        canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error("Could not resize that image.")), "image/jpeg", 0.85);
      };
      image.onerror = () => {
        URL.revokeObjectURL(source);
        reject(new Error("Could not read that image."));
      };
      image.src = source;
    });
  }

  async function boot() {
    try {
      const { data, error } = await client.auth.getSession();
      fail(error);
      await loadCatalog();
      if (data.session) {
        await activateSession(data.session.user);
      } else {
        ready = true;
        baseline = stateCopy();
        render();
      }
    } catch (error) {
      ready = true;
      authError = error.message || "Could not connect to Supabase. Run supabase/schema.sql in the SQL Editor, then reload.";
      DB = seed();
      DB.users = [];
      me = null;
      baseline = stateCopy();
      render();
    }
    const listener = client.auth.onAuthStateChange(event => {
      if (event === "SIGNED_OUT") {
        me = null;
        DB = seed();
        DB.users = [];
        baseline = null;
        page = "home";
        ready = true;
        render();
      }
    });
    authListener = listener.data.subscription;
  }

  try {
    const legacy = JSON.parse(localStorage.getItem(KEY) || "null");
    if (legacy && Array.isArray(legacy.users)) {
      legacy.users.forEach(user => delete user.password);
      localStorage.setItem(KEY, JSON.stringify(legacy));
    }
  } catch (_) {}

  boot();
})();

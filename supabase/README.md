# Supabase setup

1. Open this project's Supabase Dashboard and go to **SQL Editor**.
2. Run [`schema.sql`](schema.sql) once. It creates the app tables, indexes, seed room/equipment/time-slot rows, signup trigger, and RLS policies.
3. In **Authentication → URL Configuration**, set the Site URL to `https://classroom-reservation-ebon.vercel.app`. Add that URL to the allowed redirect URLs.
4. Enable Supabase Realtime for the tables the app uses so reservations update live for admins:

```sql
alter publication supabase_realtime add table public.profiles;
alter publication supabase_realtime add table public.rooms;
alter publication supabase_realtime add table public.equipment;
alter publication supabase_realtime add table public.time_slots;
alter publication supabase_realtime add table public.bookings;
alter publication supabase_realtime add table public.booking_equipment;
alter publication supabase_realtime add table public.teacher_schedules;
alter publication supabase_realtime add table public.damage_reports;
alter publication supabase_realtime add table public.activity_logs;
```

5. Create your first account through the app. In SQL Editor, promote that account to administrator:

```sql
update public.profiles
set role = 'Admin'
where username = 'your_username';
```

The app's browser configuration is in [`client-config.js`](client-config.js). It contains only the Supabase publishable key; never put a `service_role` or secret key in browser code. RLS is required and enabled by the schema.

The old prototype stored accounts and reservations in each browser's local storage, including plaintext passwords. Those records are not automatically imported. The Supabase schema seeds the shared room, equipment, and time-slot catalog; create new accounts with Supabase Auth.

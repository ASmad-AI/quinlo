import { BRANDING, defaultProfiles, hashPassword, newId, slugify } from "@openforge/shared";
import type { Store } from "./store";

/**
 * Development seed: a demo org, user, app, collection, profiles, and a
 * starter frontend, created only when OPENFORGE_SEED_DEMO=true and the
 * store has no users yet. Never runs in production unless the operator
 * explicitly enables it. The demo password comes from
 * OPENFORGE_DEMO_PASSWORD (default is documented in .env.example and is
 * only suitable for local throwaway use).
 */
export async function seedDemo(store: Store, demoPassword: string): Promise<{ appId: string; email: string } | null> {
  const existing = await store.findUserByEmail(`demo@${BRANDING.slug}.local`);
  if (existing) return null;
  const now = new Date().toISOString();
  const org = await store.createOrg({
    created_at: now,
    id: newId("org"),
    name: "Demo Organization",
    slug: "demo",
  });
  const user = await store.createUser({
    created_at: now,
    email: `demo@${BRANDING.slug}.local`,
    id: newId("user"),
    name: "Demo User",
    org_id: org.id,
    password_hash: hashPassword(demoPassword),
    profile_name: "Admin",
  });
  const app = await store.createApp({
    auth_config: { oauth: [], orgIsolation: true, providers: ["email"] },
    created_at: now,
    created_by: user.id,
    description: "Seeded demo app: a task board with profiles applied.",
    id: newId("app"),
    name: "Task Board",
    org_id: org.id,
    slug: slugify("Task Board"),
    updated_at: now,
  });
  await store.upsertCollection({
    app_id: app.id,
    attributes: [
      { name: "title", required: true, type: "string" },
      { name: "status", required: true, type: "string" },
      { name: "owner_id", required: false, type: "string" },
    ],
    created_at: now,
    id: newId("col"),
    indexes: [{ fields: ["status"] }],
    name: "tasks",
    org_id: org.id,
  });
  for (const p of defaultProfiles(app.id, now)) {
    await store.upsertProfile({ ...p, id: newId("profile") });
  }
  // Member profile with real rules so the demo is secure-by-default.
  await store.upsertProfile({
    appId: app.id,
    createdAt: now,
    description: "Members manage their own tasks.",
    id: newId("profile"),
    isDefault: true,
    name: "Member",
    rules: {
      tasks: {
        create: { fields: ["owner_id", "status", "title"] },
        delete: false,
        read: { fields: ["owner_id", "status", "title"] },
        update: {
          fields: ["status", "title"],
          row: [{ field: "owner_id", op: "eq", value: "$user.id" }],
        },
      },
    },
    updatedAt: now,
  });
  const starterHtml = [
    "<!doctype html>",
    "<html><head><meta charset=\"utf-8\"><title>Task Board</title>",
    "<style>body{font-family:system-ui;margin:2rem auto;max-width:640px}h1{font-size:1.5rem}</style></head>",
    "<body><h1>Task Board</h1><p>Click any element to inspect it, then edit its text.</p>",
    "<ul><li>Ship the demo</li><li>Apply a security profile</li><li>Promote to production</li></ul></body></html>",
    "",
  ].join("\n");
  await store.upsertFile({
    app_id: app.id,
    content: starterHtml,
    id: newId("file"),
    org_id: org.id,
    path: "index.html",
    size: Buffer.byteLength(starterHtml),
    updated_at: now,
  });
  await store.createRecord({
    app_id: app.id,
    collection: "tasks",
    created_at: now,
    created_by: user.id,
    fields: { owner_id: user.id, status: "open", title: "Ship the demo" },
    id: newId("rec"),
    org_id: org.id,
    updated_at: now,
  });
  return { appId: app.id, email: user.email };
}

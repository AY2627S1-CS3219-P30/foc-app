import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestApp, SERVICE_KEY, type TestApp } from './helpers/app.js';
import { activeStudent, bearer, http, TRUNCATE_ALL, type Actor } from './helpers/actors.js';

let t: TestApp;
let alex: Actor;
let sam: Actor;
const patch = (a: Actor, body: unknown) =>
  http(t)
    .patch('/users/me')
    .set('Authorization', bearer(a))
    .send(body as object);
const row = async (id: string) =>
  (
    await t.db.query(
      'SELECT u.email, u.status, u.is_seeded_admin, p.* FROM users u JOIN profiles p ON p.user_id = u.id WHERE u.id = $1',
      [id],
    )
  ).rows[0]!;

beforeAll(async () => {
  t = await createTestApp();
});
afterAll(async () => {
  await t.close();
});
beforeEach(async () => {
  await t.db.exec(TRUNCATE_ALL);
  alex = await activeStudent(t, 'alex@u.nus.edu');
  sam = await activeStudent(t, 'sam@u.nus.edu');
});

describe('PATCH /users/me (US-FR3.1.1)', () => {
  it('edits the caller’s own fields and returns the new state', async () => {
    const res = await patch(alex, {
      displayName: 'Alex T.',
      faculty: 'Computing',
      avatarRef: 'avatars/alex.png',
      contactPreference: 'EMAIL',
    }).expect(200);
    expect(res.body.profile).toEqual({
      displayName: 'Alex T.',
      faculty: 'Computing',
      avatarRef: 'avatars/alex.png',
      contactPreference: 'EMAIL',
      preferredMode: 'REQUESTER',
    });
    const again = await http(t).get('/users/me').set('Authorization', bearer(alex)).expect(200);
    expect(again.body.profile.displayName).toBe('Alex T.');
  });

  it('changes only what was sent, and can clear an optional field', async () => {
    await patch(alex, { faculty: 'Computing', displayName: 'Alex' }).expect(200);
    const res = await patch(alex, { faculty: null }).expect(200);
    expect(res.body.profile).toMatchObject({ displayName: 'Alex', faculty: null });
  });

  it.each(['id', 'email', 'roles', 'role', 'status', 'isSeededAdmin', 'createdAt', 'userId'])(
    'rejects %s as not editable and changes nothing',
    async (field) => {
      const before = await row(alex.id);
      const res = await patch(alex, {
        displayName: 'Hacked',
        [field]: field === 'roles' ? ['ADMIN'] : 'ADMIN',
      }).expect(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toContainEqual(
        expect.objectContaining({ field, code: 'FIELD_NOT_EDITABLE' }),
      );
      expect(await row(alex.id)).toEqual(before); // not even the valid displayName was applied
    },
  );

  it('rejects an empty body and invalid values', async () => {
    await patch(alex, {}).expect(422);
    await patch(alex, { displayName: '' }).expect(422);
    await patch(alex, { displayName: 'x'.repeat(51) }).expect(422);
    await patch(alex, { contactPreference: 'SMS' }).expect(422);
    await patch(alex, { preferredMode: 'ADMIN' }).expect(422);
  });

  it('cannot touch another user: the target is always the token’s subject', async () => {
    await patch(alex, { displayName: 'Only Alex' }).expect(200);
    expect((await row(sam.id)).display_name).toBe('Alex Tan'); // sam's default from registration, unchanged
    expect((await row(alex.id)).display_name).toBe('Only Alex');
    // there is no route that names another user
    await http(t)
      .patch(`/users/${sam.id}`)
      .set('Authorization', bearer(alex))
      .send({ displayName: 'x' })
      .expect(404);
  });

  it('needs authentication', async () => {
    await http(t).patch('/users/me').send({ displayName: 'x' }).expect(401);
  });

  it('the requester↔courier switch changes the UI preference and no authorization decision (US-FR2.1.2)', async () => {
    const res = await patch(alex, { preferredMode: 'COURIER' }).expect(200);
    expect(res.body.profile.preferredMode).toBe('COURIER');

    // same permissions in either mode
    const perms = () =>
      http(t).get(`/internal/users/${alex.id}/permissions`).set('x-service-key', SERVICE_KEY);
    const courier = (await perms().expect(200)).body;
    await patch(alex, { preferredMode: 'REQUESTER' }).expect(200);
    const requester = (await perms().expect(200)).body;
    expect(courier).toEqual(requester);
    expect(courier).toMatchObject({ canPlaceOrders: true, canAcceptOrders: true, isAdmin: false });
    // and it never grants admin
    await http(t).get('/admin/users').set('Authorization', bearer(alex)).expect(403);
  });

  it('ignores client-supplied role headers everywhere', async () => {
    for (const header of ['x-role', 'x-user-role', 'x-roles', 'role']) {
      await http(t)
        .get('/admin/users')
        .set('Authorization', bearer(alex))
        .set(header, 'ADMIN')
        .expect(403);
    }
  });
});

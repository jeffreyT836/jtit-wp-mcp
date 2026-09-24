import { afterEach, describe, expect, it } from 'vitest';
import { createHarness, createMockFetch, jsonResponse, makeSite, type Harness } from '../helpers/harness.js';

function textOf(result: Awaited<ReturnType<Harness['client']['callTool']>>): string {
  return (result.content as Array<{ type: string; text: string }>)[0]!.text;
}

const ME = { id: 1, username: 'mcp-bot', name: 'MCP Bot', roles: ['administrator'] };

describe('tools/users', () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    await harness?.close();
    harness = undefined;
  });

  it('list_users maps fields and forwards roles/search as query params', async () => {
    let capturedUrl = '';
    harness = await createHarness({
      sites: [makeSite({ id: 'acme' })],
      fetch: createMockFetch((url) => {
        capturedUrl = url;
        return jsonResponse(
          [{ id: 2, username: 'jane', name: 'Jane', email: 'jane@example.com', roles: ['editor'], registered_date: '2024-01-01' }],
          { headers: { 'x-wp-totalpages': '1' } },
        );
      }),
    });

    const result = await harness.client.callTool({
      name: 'list_users',
      arguments: { site: 'acme', roles: ['editor', 'author'], search: 'jane' },
    });
    const data = JSON.parse(textOf(result));

    expect(data).toEqual([
      { id: 2, username: 'jane', name: 'Jane', email: 'jane@example.com', roles: ['editor'], registered_date: '2024-01-01' },
    ]);
    expect(capturedUrl).toContain('roles=editor%2Cauthor');
    expect(capturedUrl).toContain('search=jane');
    expect(capturedUrl).toContain('context=edit');
  });

  it('get_user fetches by id with context=edit', async () => {
    harness = await createHarness({
      sites: [makeSite({ id: 'acme' })],
      fetch: createMockFetch((url) => {
        expect(url).toContain('/wp/v2/users/7');
        expect(url).toContain('context=edit');
        return jsonResponse({ id: 7, username: 'bob', roles: ['subscriber'] });
      }),
    });
    const result = await harness.client.callTool({ name: 'get_user', arguments: { site: 'acme', id: 7 } });
    expect(JSON.parse(textOf(result))).toMatchObject({ id: 7, username: 'bob', roles: ['subscriber'] });
  });

  it('list_roles calls the bridge route, only adding include_caps when requested', async () => {
    let capturedUrl = '';
    harness = await createHarness({
      sites: [makeSite({ id: 'acme' })],
      fetch: createMockFetch((url) => {
        capturedUrl = url;
        return jsonResponse({ roles: [{ slug: 'editor', name: 'Editor', user_count: 3 }] });
      }),
    });

    const result = await harness.client.callTool({ name: 'list_roles', arguments: { site: 'acme' } });
    expect(capturedUrl).toContain('/nb-mcp/v1/roles');
    expect(capturedUrl).not.toContain('include_caps');
    expect(JSON.parse(textOf(result))).toMatchObject({ roles: [{ slug: 'editor' }] });

    const result2 = await harness.client.callTool({
      name: 'list_roles',
      arguments: { site: 'acme', include_caps: true },
    });
    expect(capturedUrl).toContain('include_caps=1');
    expect(result2.isError).toBeUndefined();
  });

  describe('create_user', () => {
    it('dry-run previews without writing and never shows a provided password', async () => {
      let called = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch(() => {
          called = true;
          return jsonResponse({});
        }),
      });

      const result = await harness.client.callTool({
        name: 'create_user',
        arguments: { site: 'acme', username: 'newuser', email: 'new@example.com', password: 'super-secret-pw' },
      });
      const text = textOf(result);

      expect(called).toBe(false);
      expect(text).not.toContain('super-secret-pw');
      expect(JSON.parse(text)).toMatchObject({ dryRun: true, wouldDo: { action: 'create_user', username: 'newuser' } });
      expect(harness.auditEntries).toHaveLength(0);
    });

    it('confirmed with a generated password never returns or audits the password', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          expect(url).toContain('/wp/v2/users');
          expect(init?.method).toBe('POST');
          const body = JSON.parse(String(init?.body));
          expect(body.username).toBe('newuser');
          expect(typeof body.password).toBe('string');
          expect(body.password.length).toBeGreaterThanOrEqual(24);
          return jsonResponse({ id: 42, username: 'newuser', email: 'new@example.com', roles: ['subscriber'] });
        }),
      });

      const result = await harness.client.callTool({
        name: 'create_user',
        arguments: { site: 'acme', username: 'newuser', email: 'new@example.com', confirm: true },
      });
      const text = textOf(result);
      const data = JSON.parse(text);

      expect(data).toMatchObject({ id: 42, username: 'newuser' });
      expect(data.password).toBeUndefined();
      expect(text).not.toMatch(/"password":\s*"[^"]{8,}"/);
      expect(harness.auditEntries).toHaveLength(1);
      expect(JSON.stringify(harness.auditEntries[0])).not.toContain('super-secret');
      expect((harness.auditEntries[0]!.args as Record<string, unknown>).password).toBeUndefined();
    });

    it('confirmed with an explicit password redacts it in the audit log', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch(() => jsonResponse({ id: 43, username: 'newuser2' })),
      });

      await harness.client.callTool({
        name: 'create_user',
        arguments: { site: 'acme', username: 'newuser2', email: 'n2@example.com', password: 'super-secret-pw', confirm: true },
      });

      expect(harness.auditEntries).toHaveLength(1);
      const args = harness.auditEntries[0]!.args as Record<string, unknown>;
      expect(args.password).toBe('[redacted]');
      expect(JSON.stringify(harness.auditEntries[0])).not.toContain('super-secret-pw');
    });

    it('is not registered when MCP_READ_ONLY is true', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })], readOnlyGlobal: true });
      const { tools } = await harness.client.listTools();
      expect(tools.find((t) => t.name === 'create_user')).toBeUndefined();
    });
  });

  describe('update_user_roles', () => {
    it('dry-run shows current -> requested roles and makes no write request', async () => {
      let wroteRequest = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          if (init?.method && init.method !== 'GET') wroteRequest = true;
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          return jsonResponse({ id: 5, username: 'jane', roles: ['subscriber'] });
        }),
      });

      const result = await harness.client.callTool({
        name: 'update_user_roles',
        arguments: { site: 'acme', id: 5, roles: ['editor'] },
      });
      const data = JSON.parse(textOf(result));

      expect(wroteRequest).toBe(false);
      expect(data).toMatchObject({ dryRun: true, wouldDo: { from: ['subscriber'], to: ['editor'] } });
      expect(harness.auditEntries).toHaveLength(0);
    });

    it('refuses to remove the administrator role from the bot’s own account (dry-run)', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          return jsonResponse(ME); // target id === me.id, currently administrator
        }),
      });

      const result = await harness.client.callTool({
        name: 'update_user_roles',
        arguments: { site: 'acme', id: 1, roles: ['editor'] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/lock/i);
    });

    it('refuses the same lockout when confirmed, and audits the failure', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          return jsonResponse(ME);
        }),
      });

      const result = await harness.client.callTool({
        name: 'update_user_roles',
        arguments: { site: 'acme', id: 1, roles: ['editor'], confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ ok: false });
    });

    it('confirmed applies the role change for a different user', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          if (init?.method === 'POST') {
            const body = JSON.parse(String(init.body));
            expect(body).toEqual({ roles: ['editor'] });
            return jsonResponse({ id: 5, username: 'jane', roles: ['editor'] });
          }
          return jsonResponse({ id: 5, username: 'jane', roles: ['subscriber'] });
        }),
      });

      const result = await harness.client.callTool({
        name: 'update_user_roles',
        arguments: { site: 'acme', id: 5, roles: ['editor'], confirm: true },
      });
      expect(JSON.parse(textOf(result))).toMatchObject({ id: 5, roles: ['editor'] });
      expect(harness.auditEntries).toHaveLength(1);
      expect(harness.auditEntries[0]).toMatchObject({ ok: true, tool: 'update_user_roles' });
    });

    it('refuses a confirmed write against a readOnly site after the safety check passes', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme', readOnly: true })],
        fetch: createMockFetch((url) => {
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          return jsonResponse({ id: 5, username: 'jane', roles: ['subscriber'] });
        }),
      });
      const result = await harness.client.callTool({
        name: 'update_user_roles',
        arguments: { site: 'acme', id: 5, roles: ['editor'], confirm: true },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/read-only/);
    });

    it('is not registered when MCP_READ_ONLY is true', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })], readOnlyGlobal: true });
      const { tools } = await harness.client.listTools();
      expect(tools.find((t) => t.name === 'update_user_roles')).toBeUndefined();
    });
  });

  describe('delete_user', () => {
    it('refuses when reassign equals id, without any network call', async () => {
      let called = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch(() => {
          called = true;
          return jsonResponse({});
        }),
      });
      const result = await harness.client.callTool({
        name: 'delete_user',
        arguments: { site: 'acme', id: 9, reassign: 9 },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/reassign/);
      expect(called).toBe(false);
    });

    it('refuses to delete the bot’s own account', async () => {
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url) => {
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          return jsonResponse(ME);
        }),
      });
      const result = await harness.client.callTool({
        name: 'delete_user',
        arguments: { site: 'acme', id: 1, reassign: 2 },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toMatch(/lock/i);
    });

    it('dry-run shows the target user and reassign target, without deleting', async () => {
      let deleteCalled = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          if (init?.method === 'DELETE') deleteCalled = true;
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          return jsonResponse({ id: 9, username: 'gone-soon', name: 'Gone Soon' });
        }),
      });
      const result = await harness.client.callTool({
        name: 'delete_user',
        arguments: { site: 'acme', id: 9, reassign: 1 },
      });
      const data = JSON.parse(textOf(result));
      expect(deleteCalled).toBe(false);
      expect(data).toMatchObject({
        dryRun: true,
        wouldDo: { user: { id: 9, username: 'gone-soon' }, reassign: 1 },
      });
    });

    it('confirmed issues DELETE with force=true and reassign', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          if (url.includes('/wp/v2/users/me')) return jsonResponse(ME);
          if (init?.method === 'DELETE') {
            capturedUrl = url;
            return jsonResponse({ deleted: true });
          }
          return jsonResponse({ id: 9, username: 'gone-soon' });
        }),
      });
      const result = await harness.client.callTool({
        name: 'delete_user',
        arguments: { site: 'acme', id: 9, reassign: 1, confirm: true },
      });
      expect(capturedUrl).toContain('/wp/v2/users/9');
      expect(capturedUrl).toContain('force=true');
      expect(capturedUrl).toContain('reassign=1');
      expect(JSON.parse(textOf(result))).toMatchObject({ deleted: true });
      expect(harness.auditEntries).toHaveLength(1);
    });
  });

  it('list_application_passwords maps fields', async () => {
    harness = await createHarness({
      sites: [makeSite({ id: 'acme' })],
      fetch: createMockFetch(() =>
        jsonResponse([
          { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'laptop', created: '2024-01-01', last_used: null, last_ip: null },
        ]),
      ),
    });
    const result = await harness.client.callTool({ name: 'list_application_passwords', arguments: { site: 'acme', id: 1 } });
    expect(JSON.parse(textOf(result))).toEqual([
      { uuid: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', name: 'laptop', created: '2024-01-01', last_used: null, last_ip: null },
    ]);
  });

  describe('revoke_application_password', () => {
    const UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

    it('dry-run makes no write request', async () => {
      let called = false;
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch(() => {
          called = true;
          return jsonResponse({});
        }),
      });
      const result = await harness.client.callTool({
        name: 'revoke_application_password',
        arguments: { site: 'acme', id: 1, uuid: UUID },
      });
      expect(called).toBe(false);
      expect(JSON.parse(textOf(result))).toMatchObject({ dryRun: true, wouldDo: { uuid: UUID } });
    });

    it('confirmed deletes the application password by uuid', async () => {
      let capturedUrl = '';
      harness = await createHarness({
        sites: [makeSite({ id: 'acme' })],
        fetch: createMockFetch((url, init) => {
          capturedUrl = url;
          expect(init?.method).toBe('DELETE');
          return jsonResponse({ deleted: true });
        }),
      });
      const result = await harness.client.callTool({
        name: 'revoke_application_password',
        arguments: { site: 'acme', id: 1, uuid: UUID, confirm: true },
      });
      expect(capturedUrl).toContain(`/wp/v2/users/1/application-passwords/${UUID}`);
      expect(JSON.parse(textOf(result))).toMatchObject({ deleted: true });
      expect(harness.auditEntries).toHaveLength(1);
    });

    it('is not registered when MCP_READ_ONLY is true', async () => {
      harness = await createHarness({ sites: [makeSite({ id: 'acme' })], readOnlyGlobal: true });
      const { tools } = await harness.client.listTools();
      expect(tools.find((t) => t.name === 'revoke_application_password')).toBeUndefined();
    });
  });
});

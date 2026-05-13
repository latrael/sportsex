import { describe, it, expect, beforeEach, vi } from 'vitest';
import { db, cleanDb, createUser, createPlayer, makeRequest } from '../helpers';

vi.mock('@/lib/auth', () => ({ auth: vi.fn() }));

import { auth } from '@/lib/auth';
import { POST as report } from '@/app/api/comments/[id]/report/route';

const mockAuth = vi.mocked(auth);

beforeEach(async () => {
  await cleanDb();
  vi.clearAllMocks();
});

async function makeComment(authorId: string, playerId: number) {
  return db.comment.create({ data: { userId: authorId, playerId, body: 'great player', status: 'visible' } });
}

function reportReq(commentId: number) {
  return makeRequest(`/api/comments/${commentId}/report`, { method: 'POST' });
}

describe('POST /api/comments/[id]/report', () => {
  it('returns 401 when not signed in', async () => {
    mockAuth.mockResolvedValue(null as never);
    const res = await report(reportReq(1), { params: { id: '1' } });
    expect(res.status).toBe(401);
  });

  it('flags a visible comment', async () => {
    const author = await createUser();
    const reporter = await createUser();
    const player = await createPlayer();
    const comment = await makeComment(author.id, player.id);

    mockAuth.mockResolvedValue({ user: { id: reporter.id } } as never);
    const res = await report(reportReq(comment.id), { params: { id: String(comment.id) } });
    expect(res.status).toBe(200);

    const updated = await db.comment.findUnique({ where: { id: comment.id } });
    expect(updated?.status).toBe('flagged');
  });

  it('rejects reporting your own comment', async () => {
    const user = await createUser();
    const player = await createPlayer();
    const comment = await makeComment(user.id, player.id);

    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await report(reportReq(comment.id), { params: { id: String(comment.id) } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('cannot_report_own');
  });

  it('rejects reporting a hidden comment', async () => {
    const author = await createUser();
    const reporter = await createUser();
    const player = await createPlayer();
    const comment = await db.comment.create({ data: { userId: author.id, playerId: player.id, body: 'bad take', status: 'hidden' } });

    mockAuth.mockResolvedValue({ user: { id: reporter.id } } as never);
    const res = await report(reportReq(comment.id), { params: { id: String(comment.id) } });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('already_hidden');
  });

  it('returns 404 for nonexistent comment', async () => {
    const user = await createUser();
    mockAuth.mockResolvedValue({ user: { id: user.id } } as never);
    const res = await report(reportReq(999999), { params: { id: '999999' } });
    expect(res.status).toBe(404);
  });
});

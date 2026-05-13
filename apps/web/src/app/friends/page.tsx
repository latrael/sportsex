import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

function makeCode() {
  return Math.random().toString(36).slice(2, 8).toUpperCase();
}

export default async function FriendsPage({ searchParams }: { searchParams?: { msg?: string } }) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const [outgoing, incoming, accepted, myLbs, joinedLbs] = await Promise.all([
    prisma.friendship.findMany({ where: { userId, status: 'pending' }, include: { friend: true } }),
    prisma.friendship.findMany({ where: { friendId: userId, status: 'pending' }, include: { user: true } }),
    prisma.friendship.findMany({
      where: { OR: [{ userId, status: 'accepted' }, { friendId: userId, status: 'accepted' }] },
      include: { user: true, friend: true },
    }),
    prisma.privateLeaderboard.findMany({ where: { ownerId: userId } }),
    prisma.privateLeaderboardMember.findMany({ where: { userId }, include: { leaderboard: true } }),
  ]);

  async function sendRequest(formData: FormData) {
    'use server';
    if (!userId) return;
    const handle = String(formData.get('handle') ?? '').trim();
    const target = await prisma.user.findUnique({ where: { handle } });
    if (!target || target.id === userId) {
      revalidatePath('/friends');
      return;
    }
    await prisma.friendship.upsert({
      where: { userId_friendId: { userId, friendId: target.id } },
      update: {},
      create: { userId, friendId: target.id, status: 'pending' },
    });
    revalidatePath('/friends');
  }

  async function acceptRequest(formData: FormData) {
    'use server';
    const id = parseInt(String(formData.get('id') ?? ''), 10);
    if (!Number.isFinite(id)) return;
    await prisma.friendship.update({ where: { id }, data: { status: 'accepted' } });
    revalidatePath('/friends');
  }

  async function createLeaderboard(formData: FormData) {
    'use server';
    if (!userId) return;
    const name = String(formData.get('name') ?? '').trim().slice(0, 40);
    if (!name) return;
    await prisma.privateLeaderboard.create({
      data: { name, joinCode: makeCode(), ownerId: userId },
    });
    revalidatePath('/friends');
  }

  async function joinLeaderboard(formData: FormData) {
    'use server';
    if (!userId) return;
    const code = String(formData.get('code') ?? '').trim().toUpperCase();
    const lb = await prisma.privateLeaderboard.findUnique({ where: { joinCode: code } });
    if (!lb || lb.ownerId === userId) return;
    await prisma.privateLeaderboardMember.upsert({
      where: { leaderboardId_userId: { leaderboardId: lb.id, userId } },
      update: {},
      create: { leaderboardId: lb.id, userId },
    });
    revalidatePath('/friends');
  }

  return (
    <div className="space-y-6">
      <section>
        <h1 className="text-2xl font-semibold mb-3">Friends</h1>
        <form action={sendRequest} className="card flex gap-2 mb-3">
          <input className="input max-w-xs" name="handle" placeholder="@handle" required />
          <button className="btn btn-primary" type="submit">Send request</button>
        </form>

        {incoming.length > 0 && (
          <div className="card mb-3">
            <h3 className="font-semibold mb-2">Incoming requests</h3>
            {incoming.map((f) => (
              <form key={f.id} action={acceptRequest} className="flex items-center gap-2 py-1">
                <input type="hidden" name="id" value={f.id} />
                <span className="flex-1">@{f.user.handle}</span>
                <button className="btn btn-primary" type="submit">Accept</button>
              </form>
            ))}
          </div>
        )}

        <div className="card">
          <h3 className="font-semibold mb-2">Friends ({accepted.length})</h3>
          {accepted.length === 0 ? (
            <p className="text-mute text-sm">No friends yet.</p>
          ) : (
            <ul className="space-y-1">
              {accepted.map((f) => {
                const other = f.userId === userId ? f.friend : f.user;
                return <li key={f.id}>@{other.handle}</li>;
              })}
            </ul>
          )}
        </div>

        {outgoing.length > 0 && (
          <div className="card mt-3">
            <h3 className="font-semibold mb-2">Pending (outgoing)</h3>
            <ul className="text-mute text-sm">
              {outgoing.map((f) => <li key={f.id}>@{f.friend.handle}</li>)}
            </ul>
          </div>
        )}
      </section>

      <section>
        <h2 className="text-2xl font-semibold mb-3">Private leaderboards</h2>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          <form action={createLeaderboard} className="card flex gap-2">
            <input className="input" name="name" placeholder="Group name" required />
            <button className="btn btn-primary" type="submit">Create</button>
          </form>
          <form action={joinLeaderboard} className="card flex gap-2">
            <input className="input" name="code" placeholder="Join code (e.g. AB12CD)" required />
            <button className="btn" type="submit">Join</button>
          </form>
        </div>
        <div className="card mt-3">
          {myLbs.length === 0 && joinedLbs.length === 0 ? (
            <p className="text-mute text-sm">No groups yet.</p>
          ) : (
            <ul className="space-y-2">
              {myLbs.map((lb) => (
                <li key={lb.id} className="flex justify-between items-center">
                  <span>{lb.name} <span className="chip ml-2">owner</span></span>
                  <span className="font-mono text-sm text-mute">code: {lb.joinCode}</span>
                </li>
              ))}
              {joinedLbs.map((m) => (
                <li key={m.id} className="flex justify-between items-center">
                  <span>{m.leaderboard.name}</span>
                  <span className="font-mono text-sm text-mute">code: {m.leaderboard.joinCode}</span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>
    </div>
  );
}

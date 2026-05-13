import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/db';
import { revalidatePath } from 'next/cache';

export const dynamic = 'force-dynamic';

export default async function ModeratePage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/login');

  const flagged = await prisma.comment.findMany({
    where: { status: 'flagged' },
    orderBy: { createdAt: 'desc' },
    include: { user: true, player: { select: { id: true, fullName: true } } },
    take: 100,
  });

  const hidden = await prisma.comment.findMany({
    where: { status: 'hidden' },
    orderBy: { createdAt: 'desc' },
    include: { user: true, player: { select: { id: true, fullName: true } } },
    take: 50,
  });

  async function approve(formData: FormData) {
    'use server';
    const id = parseInt(String(formData.get('id') ?? ''), 10);
    if (!Number.isFinite(id)) return;
    await prisma.comment.update({ where: { id }, data: { status: 'visible' } });
    revalidatePath('/admin/moderate');
  }

  async function hide(formData: FormData) {
    'use server';
    const id = parseInt(String(formData.get('id') ?? ''), 10);
    if (!Number.isFinite(id)) return;
    await prisma.comment.update({ where: { id }, data: { status: 'hidden' } });
    revalidatePath('/admin/moderate');
  }

  async function remove(formData: FormData) {
    'use server';
    const id = parseInt(String(formData.get('id') ?? ''), 10);
    if (!Number.isFinite(id)) return;
    await prisma.comment.delete({ where: { id } });
    revalidatePath('/admin/moderate');
  }

  function CommentRow({ c }: { c: typeof flagged[number] }) {
    return (
      <div className="card space-y-2">
        <div className="flex items-start gap-3 justify-between flex-wrap">
          <div>
            <div className="text-xs text-mute">
              @{c.user.handle} · {new Date(c.createdAt).toLocaleString()}
              {c.player && (
                <> · on <a className="text-accent" href={`/players/${c.player.id}`}>{c.player.fullName}</a></>
              )}
            </div>
            <p className="mt-1 text-sm">{c.body}</p>
          </div>
          <div className="flex gap-2 shrink-0">
            <form action={approve}>
              <input type="hidden" name="id" value={c.id} />
              <button className="btn" type="submit">Approve</button>
            </form>
            <form action={hide}>
              <input type="hidden" name="id" value={c.id} />
              <button className="btn btn-danger" type="submit">Hide</button>
            </form>
            <form action={remove}>
              <input type="hidden" name="id" value={c.id} />
              <button className="btn btn-danger" type="submit" onClick={(e) => { if (!confirm('Delete permanently?')) e.preventDefault(); }}>Delete</button>
            </form>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Moderation queue</h1>
        <p className="text-mute text-sm mt-1">Flagged comments awaiting review. Approve to restore, Hide to remove from public view.</p>
      </div>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Flagged ({flagged.length})
        </h2>
        {flagged.length === 0 ? (
          <p className="text-mute text-sm">No flagged comments.</p>
        ) : (
          <div className="space-y-3">
            {flagged.map((c) => <CommentRow key={c.id} c={c} />)}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-lg font-semibold mb-3">
          Hidden ({hidden.length})
        </h2>
        {hidden.length === 0 ? (
          <p className="text-mute text-sm">No hidden comments.</p>
        ) : (
          <div className="space-y-3">
            {hidden.map((c) => <CommentRow key={c.id} c={c} />)}
          </div>
        )}
      </section>
    </div>
  );
}

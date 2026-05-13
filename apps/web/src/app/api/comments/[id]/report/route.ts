import { NextResponse } from 'next/server';
import { prisma } from '@/lib/db';
import { auth } from '@/lib/auth';

export async function POST(
  _req: Request,
  { params }: { params: { id: string } },
) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const commentId = parseInt(params.id, 10);
  if (!Number.isFinite(commentId)) return NextResponse.json({ error: 'bad_request' }, { status: 400 });

  const comment = await prisma.comment.findUnique({ where: { id: commentId } });
  if (!comment) return NextResponse.json({ error: 'not_found' }, { status: 404 });
  if (comment.userId === userId) return NextResponse.json({ error: 'cannot_report_own' }, { status: 400 });
  if (comment.status === 'hidden') return NextResponse.json({ error: 'already_hidden' }, { status: 400 });

  await prisma.comment.update({ where: { id: commentId }, data: { status: 'flagged' } });
  return NextResponse.json({ ok: true });
}

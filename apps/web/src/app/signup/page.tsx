import { prisma } from '@/lib/db';
import { signIn } from '@/lib/auth';
import bcrypt from 'bcryptjs';
import { redirect } from 'next/navigation';
import Link from 'next/link';

export default function SignupPage({ searchParams }: { searchParams?: { error?: string } }) {
  async function signup(formData: FormData) {
    'use server';
    const email = String(formData.get('email') ?? '').toLowerCase().trim();
    const handle = String(formData.get('handle') ?? '').trim();
    const password = String(formData.get('password') ?? '');
    if (!email || !handle || password.length < 6) redirect('/signup?error=bad');

    const existsEmail = await prisma.user.findUnique({ where: { email } });
    if (existsEmail) redirect('/signup?error=email');
    const existsHandle = await prisma.user.findUnique({ where: { handle } });
    if (existsHandle) redirect('/signup?error=handle');

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await prisma.user.create({
      data: { email, handle, passwordHash, coinBalance: 10000 },
    });
    await prisma.transaction.create({
      data: {
        userId: user.id,
        assetKind: 'coin_grant',
        side: 'credit',
        coinsDelta: 10000,
        reason: 'starting_balance',
      },
    });
    await signIn('credentials', { email, password, redirectTo: '/' });
  }

  const msg: Record<string, string> = {
    bad: 'Fill all fields. Password must be 6+ characters.',
    email: 'Email already registered.',
    handle: 'Handle already taken.',
  };

  return (
    <div className="max-w-sm mx-auto card">
      <h1 className="text-xl font-semibold mb-1">Create an account</h1>
      <p className="text-mute text-sm mb-4">Start with 10,000 coins.</p>
      {searchParams?.error && <p className="text-danger text-sm mb-3">{msg[searchParams.error] ?? 'Error.'}</p>}
      <form action={signup} className="space-y-3">
        <input className="input" name="email" type="email" placeholder="Email" required />
        <input className="input" name="handle" type="text" placeholder="Handle (e.g. ovenmitt)" required />
        <input className="input" name="password" type="password" placeholder="Password (6+ chars)" required minLength={6} />
        <button className="btn btn-primary w-full justify-center" type="submit">Sign up</button>
      </form>
      <p className="text-sm text-mute mt-4">Already have an account? <Link className="text-accent" href="/login">Sign in</Link></p>
    </div>
  );
}
